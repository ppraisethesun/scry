defmodule Scry.ProtocolTest do
  use ExUnit.Case, async: true

  alias Scry.Protocol

  test "decodes an eval request" do
    payload =
      Jason.encode!(%{
        "version" => 1,
        "operation" => "eval",
        "requestId" => "request-1",
        "sessionId" => "workspace-1",
        "token" => "secret",
        "service" => "accounts",
        "code" => "1 + 2"
      })

    assert {:ok, request} = Protocol.decode_request(payload)
    assert request.operation == :eval
    assert request.service == "accounts"
    assert request.code == "1 + 2"
  end

  test "rejects unsupported protocol versions" do
    payload =
      Jason.encode!(%{
        "version" => 2,
        "operation" => "clearSession",
        "requestId" => "request-1",
        "sessionId" => "workspace-1",
        "token" => "secret"
      })

    assert {:error, {:invalid, "version"}} = Protocol.decode_request(payload)
  end

  test "compares tokens" do
    assert :ok = Protocol.authenticate("secret", "secret")
    assert {:error, :unauthorized} = Protocol.authenticate("wrong", "secret")
  end
end
