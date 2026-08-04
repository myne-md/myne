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
            url = "https://github.com/myne-md/myne/releases/download/v0.4.0/Myne_0.4.0_amd64.AppImage";
            sha256 = "8b0f6893686aec3453695ad4901adbbd62de0ca42033c9d023b88c9645f22d8c";
          };
          "aarch64-linux" = pkgs.fetchurl {
            url = "https://github.com/myne-md/myne/releases/download/v0.4.0/Myne_0.4.0_aarch64.AppImage";
            sha256 = "42ee5fc8b408c03ece37afb272685889197cec07cfd553a7b06cb4dfe55b907f";
          };
        }.${system};
    in {
      packages = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          myne = pkgs.appimageTools.wrapType2 {
            pname = "myne";
            version = "0.4.0";
            src = srcFor system pkgs;
          };
        in { default = myne; myne = myne; });

      apps = forAll (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
        myne = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
      });
    };
}
