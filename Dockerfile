FROM nginx:alpine

# Add curl so we can use it for health check
RUN apk --no-cache add curl

CMD ["nginx", "-g", "daemon off;"]