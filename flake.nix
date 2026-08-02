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
            url = "https://github.com/myne-md/myne/releases/download/v0.2.0/Myne_0.2.0_amd64.AppImage";
            sha256 = "7cda4f3b6d4ad3d5e276d34986e73f303613fa63a16df7691959376bb2e7cf74";
          };
          "aarch64-linux" = pkgs.fetchurl {
            url = "https://github.com/myne-md/myne/releases/download/v0.2.0/Myne_0.2.0_aarch64.AppImage";
            sha256 = "d7edcf8dd2313dbbaeda2aa8ea9f508d9dab516b52302e121f07d459f6be4a5d";
          };
        }.${system};
    in {
      packages = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          myne = pkgs.appimageTools.wrapType2 {
            pname = "myne";
            version = "0.2.0";
            src = srcFor system pkgs;
          };
        in { default = myne; myne = myne; });

      apps = forAll (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
        myne = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
      });
    };
}
