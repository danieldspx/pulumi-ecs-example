import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as random from "@pulumi/random";

const vpc = awsx.ec2.Vpc.getDefault();
const clusterName = 'dev-cluster';

// Create a random string that will be used to create the cluester name.
// This is usefull to avoid collision with existing clusters.
const clusterIdentifier = new random.RandomString(clusterName, {
  special: false,
  upper: false,
  length: 6,
}).result.apply(s => `${clusterName}-` + s);

// Create the cluster's security group ahead of time so we can use it for the ASG.
const clusterSecurityGroup = awsx.ecs.Cluster.createDefaultSecurityGroup(clusterName, vpc);

// Create a Security Group that will be used 
const instancesSecurityGroup = new awsx.ec2.SecurityGroup(
  'dev-instances-sg',
  {
    vpc,
    description: 'The Security group for all instances that only allow ingress of the Load Balancer.',
    // Allow ingress only on port 80 from anywhere
    ingress: [{ fromPort: 80, toPort: 80, protocol: 'tcp', cidrBlocks: [ '0.0.0.0/0' ] }],
    egress: [{ fromPort: 0, toPort: 65535, protocol: 'tcp', cidrBlocks: [ '0.0.0.0/0' ] }]
  }
);

// Here we configure some user data that will be configured into each EC2 instance.
const userData: awsx.autoscaling.AutoScalingUserData = {
  extraBootcmdLines: () => clusterIdentifier.apply(clusterId =>
    [
      { contents: `- echo ECS_CLUSTER='${clusterId}' >> /etc/ecs/ecs.config` }, // The cluster that the agent should check into.
      { contents: `- echo ECS_ENABLE_CONTAINER_METADATA=true >> /etc/ecs/ecs.config` }, // When true, the agent creates a file describing the container's metadata.
      { contents: `- echo ECS_RESERVED_MEMORY=256 >> /etc/ecs/ecs.config` }, // The amount of memory, in MiB, to remove from the pool that is allocated to your tasks.  
    ]
  ),
};

// Creates our ASG
const asg = new awsx.autoscaling.AutoScalingGroup(
  'dev-asg',
  {
    vpc,
    // Defines the min and max number os instances allowed on this ASG
    templateParameters: { minSize: 1, maxSize: 2 },
    launchConfigurationArgs: {
      // Define the instance type
      instanceType: 't2.micro' as aws.ec2.InstanceType,
      // Define a security group that will be attached to each EC2 instance in the ASG
      securityGroups: [instancesSecurityGroup.id],
      userData
    },
  },
);

// Created our Capacity provider and associates it to the ASG
const capacityProvider = new aws.ecs.CapacityProvider(
  'dev-capacity', 
  {
    autoScalingGroupProvider: {
      autoScalingGroupArn: asg.group.arn
    }
  }
);

// Creates our cluster
const cluster = new awsx.ecs.Cluster(clusterName, {
  name: clusterIdentifier,
  vpc,
  capacityProviders: [ capacityProvider.name ],
  securityGroups: [ clusterSecurityGroup ],
});

// Make sure our ASC creates more EC2 instances when the memory reservation reaches 80%
// Note that it is still constrained on the maxSize of the ASG.
asg.scaleToTrackMetric(
  'scale-memory-reserv',
  {
    metric: awsx.ecs.metrics.memoryReservation({ cluster, statistic: 'Average', unit: 'Percent' }),
    targetValue: 80,
  },
)

const taskDefinition = new awsx.ecs.EC2TaskDefinition('nginx-task-def', {
  // The network mode is host because the networking of the container is tied directly to the underlying host that's running the container.
  // Note that this brings a lot of problems, but for simplicity we will make it this way. Tipically you would
  // choose bridge mode and use random hostPorts (by setting it to zero on the portMappings) and register it into some
  // target group and then in a Load Balancer.
  networkMode: 'host',
  containers: {
    nginx: {
      image: awsx.ecs.Image.fromDockerBuild('nginx-img', {
        // context is a path to a directory to use for the Docker build context, usually the directory in which the Dockerfile resides
        context: '../'
      }),
      portMappings: [
        // If we wanted random ports on the host machine we would set hostPort to zero
        { hostPort: 80, containerPort: 80 }
      ],
      // Soft Memory reservation for our container
      memoryReservation: 256,
      // Hard Memory reservation for our container. If the container reaches this amout, it is killed
      memory: 256,
      // Health Check configuration
      healthCheck: {
        command: ['CMD-SHELL', 'curl --fail http://localhost || exit 1'],
        interval: 30,
        startPeriod: 5,
        retries: 3,
        timeout: 5,
      },
    },
  },
});

// This CapacityProviderService is a wrapper that allow us to create a service using the cluster's 
// capacity provider
const service = new awsx.ecs.CapacityProviderService('nginx-svc', {
  cluster, // Our created cluster
  taskDefinition, // The task definition we have just created above
  // Here we use the capacity provider we created some steps ago
  capacityProviderStrategies: [{ capacityProvider: capacityProvider.name, base: 1, weight: 1 }],
  // This allow use to place the tasks using some strategies. In this case it will spread across instances
  orderedPlacementStrategies: [{ type: 'spread', field: 'instanceId' }],
  // Desired number of tasks for this service
  desiredCount: 1,
  // This can be use for zero-downtime deployments. But since we are using the `host` network mode
  // we cannot do it if we only have one machine because it would conflict with the port 80 of the old version (remember that ECS control plane waits for the new launched task to get healthy before start deregistering the old task). 
  deploymentMinimumHealthyPercent: 0,
  // We make it 100% to avoid same task in the same machine, therefore avoiding port conflicts
  deploymentMaximumPercent: 100,
});