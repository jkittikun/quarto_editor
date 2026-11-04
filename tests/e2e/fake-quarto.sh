#!/usr/bin/env bash
# Stand-in for `quarto render` used by tests (E2E_FAKE_QUARTO=1 and the Rust render test).
# It mimics two ways a real render can hang the caller:
#  1. it blocks while stdin is left open (callers must pass /dev/null / "ignore"), and
#  2. like Quarto's Jupyter daemon, it leaves a background process holding stdout open.
#  3. like Quarto's temporary render folders, it creates and deletes directories quickly.
read -r -t 60 _ || true
for i in $(seq 1 30); do
  mkdir -p ".quarto/tmp$i/a/b" "intro_files/tmp$i/c"
  echo x > ".quarto/tmp$i/a/b/f.txt"
  echo y > "intro_files/tmp$i/c/g.txt"
  rm -rf ".quarto/tmp$i" "intro_files/tmp$i"
done
rm -rf intro_files
mkdir -p _book
echo "<html><body>fake render</body></html>" > _book/intro.html
echo "[1/1] intro.qmd"
echo "Output created: _book/intro.html"
sleep 30 &
exit 0
