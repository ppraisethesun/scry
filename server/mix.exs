defmodule Scry.MixProject do
  use Mix.Project

  def project do
    [
      app: :scry,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:crypto, :logger]]
  end

  defp deps do
    [
      {:jason, "~> 1.4"}
    ]
  end
end
