defmodule Scry.EvaluatorTest do
  use ExUnit.Case, async: true

  alias Scry.Evaluator

  test "evaluates expressions and captures IO" do
    assert {:ok, response, binding} =
             Evaluator.evaluate(~S|IO.puts("hello"); value = 40 + 2|, [])

    assert response["result"] == "42"
    assert response["output"] == "hello\n"
    assert binding[:value] == 42
  end

  test "uses bindings from a previous evaluation" do
    assert {:ok, _response, binding} = Evaluator.evaluate("value = 40", [])
    assert {:ok, response, _binding} = Evaluator.evaluate("value + 2", binding)
    assert response["result"] == "42"
  end

  test "formats evaluation failures" do
    assert {:error, response} = Evaluator.evaluate("raise \"boom\"", [])
    assert response["status"] == "error"
    assert response["error"] =~ "boom"
  end
end
