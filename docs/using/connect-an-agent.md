# Connect an agent to Delb

Delb provides an MCP endpoint for agents such as Hermes. A connection acts as your Delb account and can see books in your collections. You can allow it to change your reading status and personal shelves. It cannot edit or delete catalog books.

## Create a connection

1. Sign in to Delb and open **Settings > Connections**.
2. Enter a name such as `Hermes`. Select the option for personal changes if the agent should update your reading status or shelves.
3. Select **Create connection** and copy the token. Delb shows the token once.
4. Store the token as a secret on the machine running the agent. Treat it like a password.

Connections expire after one year. Create a replacement before a connection expires, then revoke the old one in **Settings > Connections**. Revocation affects future requests. A request already in progress may finish. Signing out or changing your Delb password does not revoke a connection. Revoke any connection you no longer trust.

## Connect Hermes

The Hermes machine must reach Delb over HTTPS or an encrypted private network. Use the address that reaches your Delb instance from the Hermes machine. An unencrypted LAN connection can expose the token to other network users.

Add the token to Hermes's protected `~/.hermes/.env` file:

```text
DELB_MCP_TOKEN=your-token
```

Add this entry under `mcp_servers` in `~/.hermes/config.yaml`. Replace the URL with your Delb address and preserve any existing entries.

```yaml
mcp_servers:
  delb:
    url: 'https://delb.example.com/api/mcp'
    headers:
      Authorization: 'Bearer ${DELB_MCP_TOKEN}'
```

Restart Hermes or reload its MCP connections. Ask it to find a book in your library. If you enabled personal changes, ask it to change a book's reading status or add a book to a personal shelf, then check the result in Delb. A read-only connection cannot make those changes.

The endpoint uses Streamable HTTP and a configured bearer token. It does not provide OAuth sign-in. If you use a reverse proxy, forward the `Authorization` header and all MCP requests to Delb. Do not record authorization headers in proxy logs. See the [Hermes MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) for Hermes configuration and troubleshooting.

## Available actions

The agent can list collections and your personal shelves, browse and search visible books by title, author, or identifier, and read book details. It can filter book results by collection or personal shelf. With personal changes enabled, it can set or clear your reading status and add or remove books on your shelves. Marking a book finished can also update its reading progress. The agent cannot select a different Delb user.

Collection access and shelf ownership still apply. A book that you can no longer access is unavailable to the connection. Book file paths and raw file records are not included in the MCP results. The connection does not grant file downloads, shared catalog editing, or administration.
