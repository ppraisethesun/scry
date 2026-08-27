defmodule Scry.Listener do
  @moduledoc false

  require Logger

  @spec start_link(keyword()) :: {:ok, pid()}
  def start_link(options) do
    parent = self()

    with {:ok, pid} <- Task.start_link(fn -> listen(options, parent) end) do
      receive do
        {:scry_listener_ready, ^pid} -> {:ok, pid}
      after
        5_000 -> {:error, :listener_start_timeout}
      end
    end
  end

  def child_spec(options) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [options]},
      restart: :permanent,
      type: :worker
    }
  end

  defp listen(options, parent) do
    ip = parse_ip!(Keyword.fetch!(options, :ip))
    port = Keyword.fetch!(options, :port)
    packet_size = Keyword.fetch!(options, :packet_size)

    socket_options = [
      :binary,
      packet: 4,
      packet_size: packet_size,
      active: false,
      reuseaddr: true,
      ip: ip
    ]

    {:ok, listener} = :gen_tcp.listen(port, socket_options)
    Logger.info("Scry listening on #{:inet.ntoa(ip)}:#{port}")
    send(parent, {:scry_listener_ready, self()})
    accept(listener, options)
  end

  defp accept(listener, options) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        hand_off(socket, options)
        accept(listener, options)

      {:error, reason} ->
        raise "Scry listener failed: #{inspect(reason)}"
    end
  end

  defp hand_off(socket, options) do
    {:ok, worker} =
      Task.Supervisor.start_child(Scry.ConnectionSupervisor, fn ->
        receive do
          {:serve, ^socket} -> Scry.Connection.serve(socket, options)
        end
      end)

    case :gen_tcp.controlling_process(socket, worker) do
      :ok -> send(worker, {:serve, socket})
      {:error, _reason} -> :gen_tcp.close(socket)
    end
  end

  defp parse_ip!(ip) when is_tuple(ip), do: ip

  defp parse_ip!(ip) when is_binary(ip) do
    case :inet.parse_address(String.to_charlist(ip)) do
      {:ok, parsed} -> parsed
      {:error, _reason} -> raise ArgumentError, "invalid Scry listener IP: #{inspect(ip)}"
    end
  end
end
