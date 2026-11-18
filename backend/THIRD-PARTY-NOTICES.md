# Third-party notices

## Distribution scope and installed dependencies

This repository distributes source code and lock files. It does not include Node.js, Python,
`node_modules`, a Python virtual environment, Qt wheels, cloudflared, or Antigravity binaries.
The root MIT notice does not replace licenses of upstream source or installed dependencies.

PyQt6 is offered under GPL v3 or a Riverbank commercial license, not LGPL. The public
PyQt6 wheels used by the startup script are the GPL edition; their separate PyQt6-Qt6
runtime package supplies Qt libraries under their own licenses. A distribution containing PyQt6/Qt must meet the applicable PyQt, Qt,
and third-party conditions; this source-only review is not approval of a bundled binary.
Preserve the notices and source availability obligations of the actual components shipped.

The actual locked packages checked for this source release are:
- PyQt6 6.12.1: public wheel metadata `GPL-3.0-only`; GPL v3 text included.
- PyQt6-Qt6 6.12.0: LGPL v3 runtime, with its bundled Qt/third-party notices.
- PyQt6-sip 13.13.1: BSD-2-Clause.
- qrcode 8.2: BSD-3-Clause; its license file also retains MIT-derived source attribution.
- colorama 0.4.6: BSD-3-Clause.
- ws 8.21.3: MIT.

This is an inventory, not a replacement for those packages' complete license texts.

Official references:
- https://www.riverbankcomputing.com/software/
- https://www.riverbankcomputing.com/commercial/license-faq
- https://doc.qt.io/qt-6/licensing.html

## Historical agy-tool reference

Source: https://github.com/justhil/agy-tool

Reference examined on 2026-11-18: commit `237df0b5f603122cc765aebe59b1dd1e2a06637e`,
particularly `src/patcher.rs`. It informed the supported Antigravity binary observations
used by the kernel work: template paths, fixed-size slots and context signatures. It is
not a description of the whole app or a runtime dependency.

The current `backend/features/kernel-patch.js` and `backend/features/kernel-custom-prompt.js`
are authored in this repository. They do not import, bundle or execute agy-tool source or
its runtime. PE32+ parsing, embed.FS validation, prompt planning, fixed-size writes,
readback checks and rollback handling are implemented locally. The signatures and template
paths describe the supported Antigravity builds; they are compatibility observations rather
than copied source text.

The checked tree, Cargo.toml and README supplied no explicit license establishing
redistribution permission; GitHub repository metadata reported `license: null`. An older
local comment asserting MIT was unsupported and has been removed. No particular upstream
license is claimed here, and this finding does not rule out separate permission.

No particular agy-tool license is claimed here, and the historical reference does not grant
rights to redistribute the Antigravity binary. Public distribution must still verify the
terms of the actual Antigravity files, bundled dependencies and any separately shipped
runtime components. Unrelated dependency and project notices remain in force.

## Antigrative Dashboard / AG Pulse

Source: https://github.com/YOU-SHOULD-KNOW-ME/antigrative-dashboard

Reference commit: 899a7984edbd43cc7a366a67936e80d30c2050cd

Process/socket parsing and local composer geometry checks in
`adapters/desktop/language-service-discovery.js` and `features/context-widget.js`
are adapted from this project. EasyAG does not bundle its installer, SDK or plugin runtime.

MIT License

Copyright (c) 2026 AG Pulse contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
