# Scry server

## Dependency

During monorepo development:

```elixir
{:scry, path: "../scry/server"}
```

After publishing repository to Git:

```elixir
{:scry, git: "YOUR_SCRY_GIT_URL", sparse: "server"}
```

## Supervision

```elixir
{Scry,
 ip: {0, 0, 0, 0},
 port: 4321,
 token: System.fetch_env!("SCRY_TOKEN")}
```

Optional settings:

```elixir
session_ttl_ms: :timer.minutes(30),
receive_timeout_ms: :timer.seconds(30),
packet_size: 1_048_576
```

Listener defaults to `127.0.0.1`. Set `ip` explicitly for remote access and
restrict that port at firewall level.

## Development

```console
mix deps.get
mix format --check-formatted
mix test
```
