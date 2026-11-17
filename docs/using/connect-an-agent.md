# Connect an agent to Delb

Delb provides an MCP endpoint for agents such as Hermes. A connection acts as your Delb account and can see books in your collections. You can allow it to change your personal reading data and, separately, shared book metadata. It cannot delete catalog books.

## Create a connection

1. Sign in to Delb and open **Settings > Connections**.
2. Enter a name such as `Hermes`. Select personal changes if the agent should update your reading data. Select shared metadata edits if it should edit books in collections where you have editor access.
3. Select **Create connection** and copy the token. Delb shows the token once.
4. Store the token as a secret on the machine running the agent. Treat it like a password.

To let an existing connection edit shared metadata, enable **Allow shared metadata edits** for that connection in **Settings > Connections**. Your existing token stays the same. You can turn this permission off at any time.

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

Restart Hermes or reload its MCP connections. Ask it to find a book in your library. If you enabled personal changes, ask it to change a book's reading status or add a book to a personal shelf, then check the result in Delb. If you enabled metadata edits, ask it to propose a correction and apply it to a book you can edit. A read-only connection cannot make those changes. If Hermes uses a tool allowlist, enable any new tools in its configuration.

The endpoint uses Streamable HTTP and a configured bearer token. It does not provide OAuth sign-in. If you use a reverse proxy, forward the `Authorization` header and all MCP requests to Delb. Do not record authorization headers in proxy logs. See the [Hermes MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) for Hermes configuration and troubleshooting.

## Available actions

The agent can list collections and your personal shelves, browse and search visible books by title, author, identifier, or reading status, and read book details. It can filter book results by collection or personal shelf. Book details and search results include your reading dates, TBR rank, and private note when present. The TBR queue tool lists your visible To be read books in their saved global order with their notes.

With personal changes enabled, the agent can set or clear your reading status, edit your start, finish, and DNF dates, move a book to a TBR position, edit your private book note, and add or remove books on your shelves. The TBR note is the same private note shown in Delb and persists if the book leaves the queue. Dates follow Delb's status rules; changing or clearing a date can also change the status. Marking a book finished can update reading progress. Delb does not store a date when a book entered To be read.

With shared metadata edits enabled, the agent can update title, authors, description, publication date, language, pages, publisher, series, identifiers, and tags on books you can edit. The agent reads the book first and sends its metadata version with the update. If the metadata changed in the meantime, Delb rejects the edit and the agent must read it again. Omitted fields remain unchanged. An explicit empty list or null clears fields where supported; authors, tags, and identifiers replace their existing lists. Changing a title or authors can move managed book storage. The update result reports a storage warning if the metadata saved but that move failed.

Collection access and shelf ownership still apply. A book that you can no longer access is unavailable to the connection. Book file paths and raw file records are not included in the MCP results. The connection does not grant file downloads, catalog deletion, or administration.
