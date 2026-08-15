{
  # A wrap-the-release flake: `nix run github:myne-md/myne` runs the published
  # AppImage under an FHS shim. (The from-source Tauri-on-Nix build — webkitgtk
  # + wrapGAppsHook + pnpm + sidecars — is a follow-up; this exists so Nix/NixOS
  # users can run it without appimage-run gymnastics.)
  #
  # The URLs point at downloads.myne.md, not at GitHub, and that is not a
  # preference. Every myne-md repository is private, so a release-asset URL on
  # github.com answers 404 to everyone who is not a member, and `fetchurl`
  # carries no credential. These URLs were pinned to v0.4.0 GitHub assets, so
  # `nix run` had never once worked for an outside user and nothing said so.
  # `decisions.md` 2026-08-15 (entry 0496).
  #
  # Fetching from the project's own origin does not cross the 2026-08-09 line
  # against Myne-initiated downloads: Nix is not a Myne client, an AppImage is
  # not a model, and the fetch happens because the user ran `nix run`.
  description = "Myne — calm, end-to-end-encrypted markdown notes";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
      srcFor = system: pkgs:
        {
          "x86_64-linux" = pkgs.fetchurl {
            url = "https://downloads.myne.md/releases/v0.5.0/Myne_0.5.0_amd64.AppImage";
            sha256 = "4503f31337319ee2d2675e63268024c84798cc171598dae36515d3cb6afbfbbd";
          };
          "aarch64-linux" = pkgs.fetchurl {
            url = "https://downloads.myne.md/releases/v0.5.0/Myne_0.5.0_aarch64.AppImage";
            sha256 = "41dc4727dbaa17ba86a742041ebf2fca7f93e5712636971f1519e2b40021c26e";
          };
        }.${system};
    in {
      packages = forAll (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          myne = pkgs.appimageTools.wrapType2 {
            pname = "myne";
            version = "0.5.0";
            src = srcFor system pkgs;
          };
        in { default = myne; myne = myne; });

      apps = forAll (system: {
        default = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
        myne = { type = "app"; program = "${self.packages.${system}.default}/bin/myne"; };
      });
    };
}
