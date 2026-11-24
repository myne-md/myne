// SPDX-License-Identifier: AGPL-3.0-only
// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    myne_mobile_lib::run()
}
