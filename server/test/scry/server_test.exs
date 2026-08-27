defmodule Scry.ServerTest do
  use ExUnit.Case

  test "evaluates through packet-4 TCP and keeps session bindings" do
    port = free_port()

    start_supervised!(
      {Scry, ip: {127, 0, 0, 1}, port: port, token: "secret", session_ttl_ms: 5_000}
    )

    first = request(port, eval_request("value = 40", "request-1"))
    second = request(port, eval_request("value + 2", "request-2"))

    assert first["status"] == "ok"
    assert second["result"] == "42"

    cleared = request(port, clear_request("request-3"))
    after_clear = request(port, eval_request("value + 2", "request-4"))

    assert cleared["result"] == "Session cleared"
    assert after_clear["status"] == "error"
    assert after_clear["error"] =~ "CompileError"
  end

  defp eval_request(code, request_id) do
    %{
      "version" => 1,
      "operation" => "eval",
      "requestId" => request_id,
      "sessionId" => "workspace-1",
      "token" => "secret",
      "service" => "accounts",
      "code" => code
    }
  end

  defp clear_request(request_id) do
    %{
      "version" => 1,
      "operation" => "clearSession",
      "requestId" => request_id,
      "sessionId" => "workspace-1",
      "token" => "secret",
      "service" => "accounts"
    }
  end

  defp request(port, request) do
    {:ok, socket} =
      :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, packet: 4, active: false], 1_000)

    :ok = :gen_tcp.send(socket, Jason.encode!(request))
    {:ok, payload} = :gen_tcp.recv(socket, 0, 1_000)
    :ok = :gen_tcp.close(socket)
    Jason.decode!(payload)
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, {_ip, port}} = :inet.sockname(socket)
    :ok = :gen_tcp.close(socket)
    port
  end
end
