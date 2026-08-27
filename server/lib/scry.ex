defmodule Scry do
  @moduledoc """
  Runs Scry's private TCP eval endpoint inside an Elixir application.

  Add `{Scry, options}` to the application's supervision tree. The endpoint
  evaluates code on that application node.
  """

  use Supervisor

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(options) do
    Supervisor.start_link(__MODULE__, options, name: __MODULE__)
  end

  @impl true
  def init(options) do
    token = Keyword.fetch!(options, :token)

    if token == "" do
      raise ArgumentError, "Scry token cannot be empty"
    end

    session_ttl_ms = Keyword.get(options, :session_ttl_ms, :timer.minutes(30))

    listener_options = [
      ip: Keyword.get(options, :ip, {127, 0, 0, 1}),
      port: Keyword.get(options, :port, 4321),
      token: token,
      session_ttl_ms: session_ttl_ms,
      receive_timeout_ms: Keyword.get(options, :receive_timeout_ms, :timer.seconds(30)),
      packet_size: Keyword.get(options, :packet_size, 1_048_576)
    ]

    children = [
      {Registry, keys: :unique, name: Scry.SessionRegistry},
      {DynamicSupervisor, strategy: :one_for_one, name: Scry.SessionSupervisor},
      {Task.Supervisor, name: Scry.ConnectionSupervisor},
      {Scry.Listener, listener_options}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
