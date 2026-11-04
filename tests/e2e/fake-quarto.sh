#!/bin/sh
# Stand-in for `quarto render` used by the e2e test (E2E_FAKE_QUARTO=1). Like real Quarto with its
# Jupyter daemon, it leaves a background process holding stdout open after it exits.
mkdir -p _book
echo "<html><body>fake render</body></html>" > _book/intro.html
echo "[1/1] intro.qmd"
echo "Output created: _book/intro.html"
sleep 30 &
exit 0
