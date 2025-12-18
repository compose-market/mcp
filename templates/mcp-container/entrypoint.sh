#!/bin/sh
# Universal MCP Server Entrypoint
# Wraps stdio MCP server with supergateway for HTTP/SSE transport

set -e

# Run the MCP server under supergateway to expose stdio via SSE
exec supergateway --stdio "npx ${SERVER_PACKAGE}" --port 8080
