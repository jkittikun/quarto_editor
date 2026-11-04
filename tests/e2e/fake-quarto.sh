#!/usr/bin/env bash
# Stand-in for `quarto render` used by tests (E2E_FAKE_QUARTO=1 and the Rust render test).
# It mimics two ways a real render can hang the caller:
#  1. it blocks while stdin is left open (callers must pass /dev/null / "ignore"), and
#  2. like Quarto's Jupyter daemon, it leaves a background process holding stdout open.
read -r -t 60 _ || true
mkdir -p _book
echo "<html><body>fake render</body></html>" > _book/intro.html
echo "[1/1] intro.qmd"
echo "Output created: _book/intro.html"
sleep 30 &
exit 0
