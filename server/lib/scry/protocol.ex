defmodule Scry.Protocol do
  @moduledoc false

  import Bitwise

  defmodule Request do
    @moduledoc false
    @enforce_keys [:operation, :request_id, :session_id, :token]
    defstruct [:operation, :request_id, :session_id, :token, :service, :code]

    @type t :: %__MODULE__{
            operation: :eval | :clear_session,
            request_id: String.t(),
            session_id: String.t(),
            token: String.t(),
            service: String.t() | nil,
            code: String.t() | nil
          }
  end

  @max_identifier_bytes 200

  @spec decode_request(binary()) :: {:ok, Request.t()} | {:error, term()}
  def decode_request(payload) do
    with {:ok, value} <- Jason.decode(payload),
         :ok <- require_version(value),
         {:ok, operation} <- operation(value["operation"]),
         {:ok, request_id} <- identifier(value["requestId"], "requestId"),
         {:ok, session_id} <- identifier(value["sessionId"], "sessionId"),
         {:ok, token} <- non_empty_string(value["token"], "token"),
         {:ok, service} <- optional_identifier(value["service"], "service"),
         {:ok, code} <- code(operation, value["code"]) do
      {:ok,
       %Request{
         operation: operation,
         request_id: request_id,
         session_id: session_id,
         token: token,
         service: service,
         code: code
       }}
    else
      {:error, %Jason.DecodeError{}} -> {:error, :invalid_json}
      error -> error
    end
  end

  @spec authenticate(String.t(), String.t()) :: :ok | {:error, :unauthorized}
  def authenticate(received, expected) do
    if secure_compare(received, expected), do: :ok, else: {:error, :unauthorized}
  end

  @spec error(String.t() | nil, String.t()) :: map()
  def error(request_id, message) do
    %{
      "version" => 1,
      "requestId" => request_id,
      "status" => "error",
      "error" => message,
      "output" => "",
      "diagnostics" => []
    }
  end

  def describe_error(:invalid_json), do: "invalid JSON"
  def describe_error({:invalid, field}), do: "invalid #{field}"
  def describe_error(reason), do: "request failed: #{inspect(reason)}"

  defp require_version(%{"version" => 1}), do: :ok
  defp require_version(_value), do: {:error, {:invalid, "version"}}

  defp operation("eval"), do: {:ok, :eval}
  defp operation("clearSession"), do: {:ok, :clear_session}
  defp operation(_operation), do: {:error, {:invalid, "operation"}}

  defp code(:eval, value), do: non_empty_string(value, "code")
  defp code(:clear_session, nil), do: {:ok, nil}
  defp code(:clear_session, value) when is_binary(value), do: {:ok, value}
  defp code(:clear_session, _value), do: {:error, {:invalid, "code"}}

  defp identifier(value, field) do
    with {:ok, value} <- non_empty_string(value, field),
         true <- byte_size(value) <= @max_identifier_bytes do
      {:ok, value}
    else
      false -> {:error, {:invalid, field}}
      error -> error
    end
  end

  defp optional_identifier(nil, _field), do: {:ok, nil}
  defp optional_identifier(value, field), do: identifier(value, field)

  defp non_empty_string(value, _field) when is_binary(value) and value != "", do: {:ok, value}
  defp non_empty_string(_value, field), do: {:error, {:invalid, field}}

  defp secure_compare(left, right)
       when is_binary(left) and is_binary(right) and byte_size(left) == byte_size(right) do
    left
    |> :binary.bin_to_list()
    |> Enum.zip(:binary.bin_to_list(right))
    |> Enum.reduce(0, fn {a, b}, result -> result ||| bxor(a, b) end)
    |> Kernel.==(0)
  end

  defp secure_compare(_left, _right), do: false
end
