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