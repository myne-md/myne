// SPDX-License-Identifier: AGPL-3.0
//! Emit the six double-buffer crash fixtures as JSON for the browser seeder
//! (phase3-web-client task 105).
//!
//!   cargo run -p myne-core --features test-support \
//!     --example emit-double-buffer-fixtures > e2e-web/fixtures/double-buffer.json
//!
//! # Why an emitter and not a checked-in blob written by hand
//!
//! Every fixture is produced by driving the REAL writer with the same `Fault`
//! injection the container's unit tests use. A fixture hand-assembled in
//! TypeScript would encode a second opinion about the generation prefix and the
//! slot suffixes, and the moment it drifted the lane would be testing recovery
//! from a shape production never produces — a failure that looks like a passing
//! test.
//!
//! The output IS checked in (the browser lane cannot run cargo), which makes
//! this emitter the thing that keeps it honest: re-run it and the file either
//! matches or the container changed.

use myne_core::double_buffer_fixtures::{build_fixtures, to_json};
use myne_core::test_support::{block_on, ScopedTempDir};
use myne_core::vault_io::StdVaultIo;

fn main() {
    let tmp = ScopedTempDir::new("db-fixtures").expect("scratch dir");
    let fixtures = block_on(build_fixtures(&StdVaultIo, tmp.path())).expect("build fixtures");
    assert_eq!(
        fixtures.len(),
        6,
        "the lane names six fixtures; emitting a different number would silently \
         change what the seeder can ask for"
    );
    println!("{}", to_json(&fixtures));
}
