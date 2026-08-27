defmodule Scry.Session do
  @moduledoc false

  use GenServer, restart: :temporary

  @type scope :: {String.t(), String.t()}

  @spec eval(scope(), pos_integer(), (keyword() -> Scry.Evaluator.result())) :: map()
  def eval(scope, ttl_ms, evaluator) do
    pid = ensure_started(scope, ttl_ms)
    GenServer.call(pid, {:eval, evaluator}, :infinity)
  end

  @spec clear(scope()) :: :ok
  def clear(scope) do
    case Registry.lookup(Scry.SessionRegistry, scope) do
      [{pid, _value}] -> GenServer.stop(pid, :normal)
      [] -> :ok
    end
  end

  def start_link({scope, ttl_ms}) do
    GenServer.start_link(__MODULE__, ttl_ms, name: via(scope))
  end

  @impl true
  def init(ttl_ms) do
    {:ok, %{binding: [], ttl_ms: ttl_ms, timer: expiry_timer(ttl_ms)}}
  end

  @impl true
  def handle_call({:eval, evaluator}, _from, state) do
    state = refresh_expiry(state)

    case evaluator.(state.binding) do
      {:ok, response, binding} -> {:reply, response, %{state | binding: binding}}
      {:error, response} -> {:reply, response, state}
    end
  end

  @impl true
  def handle_info(:expire, state), do: {:stop, :normal, state}

  defp ensure_started(scope, ttl_ms) do
    child = {__MODULE__, {scope, ttl_ms}}

    case DynamicSupervisor.start_child(Scry.SessionSupervisor, child) do
      {:ok, pid} -> pid
      {:error, {:already_started, pid}} -> pid
    end
  end

  defp via(scope), do: {:via, Registry, {Scry.SessionRegistry, scope}}

  defp refresh_expiry(state) do
    Process.cancel_timer(state.timer)
    %{state | timer: expiry_timer(state.ttl_ms)}
  end

  defp expiry_timer(ttl_ms), do: Process.send_after(self(), :expire, ttl_ms)
end
