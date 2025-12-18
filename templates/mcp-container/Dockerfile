FROM node:25-alpine
WORKDIR /app

# Install system dependencies and supergateway
RUN apk add --no-cache git python3 py3-pip build-base && \
    npm install -g supergateway

# Server package (build arg)
ARG SERVER_PACKAGE
RUN npm install -g ${SERVER_PACKAGE}

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:8080/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
