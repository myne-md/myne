{
  # Myne v0.1 team demo — a wrap-the-release flake: `nix run github:myne-md/myne`
  # runs the published AppImage under an FHS shim. (The from-source Tauri-on-Nix
  # build — webkitgtk + wrapGAppsHook + pnpm + sidecars — is a follow-up; this
  # exists so Nix/NixOS users can run the demo without appimage-run gymnastics.)
  description = "Myne — calm, end-to-end-encrypted markdown notes (v0.1 team demo)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
      srcFor = system: pkgs:
        {
          "x86_64-linux" = pkgs.fetchurl {
            url = "https://github.com/myne-md/myne/releases/download/v0.3.0/Myne_0.3.0_amd64.AppImage";
            sha256 = "353d2f8fd57602b0f67030e2cb62242cf3f8012b04fda291a8d4aba924638382";
          };
          "aarch64-linux" = pkgs.fetchurl {
            url = "https://github.com/myne-md/myne/releases/download/v0.3.0/Myne_0.3.0_aarch64.AppImage";
            sha256 = "b8b1db4f5f50cd820e62cedd8d8bf256cd2c1c37d71d5dd7af26bb50da51d873";
          };
        }.${system};
    in {
      packages = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          myne = pkgs.appimageTools.wrapType2 {
            pname = "myne";
            version = "0.3.0";
            src = srcFor system pkgs;
          };
        in { default = myne; myne = myne; });

      apps = forAll (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
        myne = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
      });
    };
}
