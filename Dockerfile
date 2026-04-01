FROM node:18-slim

# Install the MCP server globally
RUN npm install -g @aryanbv/pdf-toolkit-mcp@0.2.3

# The MCP server communicates via stdio
ENTRYPOINT ["pdf-toolkit-mcp"]
