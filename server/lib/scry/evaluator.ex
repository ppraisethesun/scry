defmodule Scry.Evaluator do
  @moduledoc false

  @wrapper """
  diagnostic =
    if function_exported?(Code, :with_diagnostics, 1) do
      &Code.with_diagnostics/1
    else
      fn fun -> {fun.(), []} end
    end

  diagnostic.(fn ->
    original_group_leader = Process.group_leader()
    {:ok, capture} = StringIO.open("")
    Process.group_leader(self(), capture)

    try do
      {result, binding} = Code.eval_string(scry_code, scry_binding)
      {:ok, {_, output}} = StringIO.close(capture)
      {:ok, result, binding, output}
    rescue
      exception ->
        {:ok, {_, output}} = StringIO.close(capture)
        {:error, Exception.format(:error, exception, __STACKTRACE__), output}
    catch
      kind, reason ->
        {:ok, {_, output}} = StringIO.close(capture)
        {:error, Exception.format(kind, reason, __STACKTRACE__), output}
    after
      Process.group_leader(self(), original_group_leader)
    end
  end)
  """

  @type result :: {:ok, map(), keyword()} | {:error, map()}

  @spec evaluate(String.t(), keyword()) :: result()
  def evaluate(code, binding) do
    wrapper_binding = [scry_code: code, scry_binding: binding]

    case Code.eval_string(@wrapper, wrapper_binding) do
      {{{:ok, result, next_binding, output}, diagnostics}, _wrapper_binding} ->
        {:ok, success_response(result, output, diagnostics), next_binding}

      {{{:error, error, output}, diagnostics}, _wrapper_binding} ->
        {:error, error_response(error, output, diagnostics)}

      other ->
        {:error, Scry.Protocol.error(nil, "unexpected evaluator response: #{inspect(other)}")}
    end
  end

  defp success_response({:module, module, _binary, _term}, output, diagnostics) do
    %{
      "version" => 1,
      "status" => "ok",
      "kind" => "module",
      "result" => "Module #{inspect(module)} loaded",
      "loadedModule" => inspect(module),
      "output" => output,
      "diagnostics" => normalize_diagnostics(diagnostics)
    }
  end

  defp success_response(result, output, diagnostics) do
    %{
      "version" => 1,
      "status" => "ok",
      "kind" => "expression",
      "result" => inspect(result, pretty: true, limit: 10_000, printable_limit: 10_000),
      "output" => output,
      "diagnostics" => normalize_diagnostics(diagnostics)
    }
  end

  defp error_response(error, output, diagnostics) do
    %{
      "version" => 1,
      "status" => "error",
      "error" => error,
      "output" => output,
      "diagnostics" => normalize_diagnostics(diagnostics)
    }
  end

  defp normalize_diagnostics(diagnostics) do
    Enum.map(diagnostics, fn diagnostic ->
      {line, column} = position(Map.get(diagnostic, :position))

      %{
        "severity" => diagnostic |> Map.get(:severity, :warning) |> to_string(),
        "message" => Map.get(diagnostic, :message, ""),
        "file" => diagnostic |> Map.get(:file, "nofile") |> to_string(),
        "line" => line,
        "column" => column
      }
    end)
  end

  defp position({line, column}), do: {line, column}
  defp position(line) when is_integer(line), do: {max(line, 1), 1}
  defp position(_position), do: {1, 1}
end
