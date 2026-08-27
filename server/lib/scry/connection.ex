defmodule Scry.Connection do
  @moduledoc false

  alias Scry.Protocol

  require Logger

  @code_preview_length 200

  @spec serve(port(), keyword()) :: :ok
  def serve(socket, options) do
    timeout = Keyword.fetch!(options, :receive_timeout_ms)

    response =
      with {:ok, payload} <- :gen_tcp.recv(socket, 0, timeout),
           {:ok, request} <- Protocol.decode_request(payload),
           :ok <- Protocol.authenticate(request.token, Keyword.fetch!(options, :token)) do
        dispatch(request, options, peer_ip(socket))
      else
        {:error, :closed} -> nil
        {:error, :timeout} -> Protocol.error(nil, "request timed out")
        {:error, :unauthorized} -> Protocol.error(nil, "unauthorized")
        {:error, reason} -> Protocol.error(nil, Protocol.describe_error(reason))
      end

    if response do
      :gen_tcp.send(socket, Jason.encode!(response))
    end

    :gen_tcp.close(socket)
    :ok
  end

  defp dispatch(%Protocol.Request{operation: :eval} = request, options, peer_ip) do
    scope = {request.session_id, request.service || "__direct__"}
    ttl = Keyword.fetch!(options, :session_ttl_ms)

    Logger.info("Scry eval from #{peer_ip}: #{inspect(code_preview(request.code))}")

    Scry.Session.eval(scope, ttl, fn binding ->
      Scry.Evaluator.evaluate(request.code, binding)
    end)
    |> Map.put("requestId", request.request_id)
  end

  defp dispatch(%Protocol.Request{operation: :clear_session} = request, _options, _peer_ip) do
    scope = {request.session_id, request.service || "__direct__"}
    Scry.Session.clear(scope)

    %{
      "version" => 1,
      "requestId" => request.request_id,
      "status" => "ok",
      "kind" => "session",
      "result" => "Session cleared",
      "output" => "",
      "diagnostics" => []
    }
  end

  defp peer_ip(socket) do
    case :inet.peername(socket) do
      {:ok, {ip, _port}} -> ip |> :inet.ntoa() |> to_string()
      {:error, _reason} -> "unknown"
    end
  end

  defp code_preview(code) do
    normalized = code |> String.trim() |> String.replace(~r/\s+/, " ")

    if String.length(normalized) > @code_preview_length do
      String.slice(normalized, 0, @code_preview_length) <> "…"
    else
      normalized
    end
  end
end
