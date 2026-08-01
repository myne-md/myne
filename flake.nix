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
            url = "https://github.com/myne-md/myne/releases/download/v0.1.0/Myne_0.1.0_amd64.AppImage";
            sha256 = "86d618aa36da9b01a510fd15f8fcba043fb3c3ce1876d3a3e1eddf9cba128c27";
          };
          "aarch64-linux" = pkgs.fetchurl {
            url = "https://github.com/myne-md/myne/releases/download/v0.1.0/Myne_0.1.0_aarch64.AppImage";
            sha256 = "be9c964e685d3b8b5bb56e230303d236678f79757e72343015b3bf0ce84f1089";
          };
        }.${system};
    in {
      packages = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          myne = pkgs.appimageTools.wrapType2 {
            pname = "myne";
            version = "0.1.0";
            src = srcFor system pkgs;
          };
        in { default = myne; myne = myne; });

      apps = forAll (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
        myne = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
      });
    };
}
