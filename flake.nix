{
  # Source-only development shell. The old flake wrapped a published AppImage
  # and therefore contradicted the source-only release policy; this flake now
  # only provides the tools to build from the checkout. It deliberately exposes
  # no `packages` or `apps` output: there is no prebuilt Nix package to run.
  description = "Myne — source-only development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              pnpm
              rustc
              cargo
              pkg-config
              openssl
            ];
          };
        });
    };
}
