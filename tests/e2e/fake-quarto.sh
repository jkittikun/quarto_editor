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
echo "fake quarto args: $*"
mkdir -p _book
if [[ " $* " == *" --to revealjs "* ]]; then
  target="$2"
  out="${target%.*}.html"
  echo "<html><body><div class=reveal>fake slides</div></body></html>" > "$out"
  echo "Output created: $out"
  exit 0
elif [[ " $* " == *" --to pdf "* ]]; then
  echo "%PDF-1.4 fake" > _book/book.pdf
  echo "Output created: _book/book.pdf"
else
  echo "<html><body>fake render</body></html>" > _book/intro.html
  echo "[1/1] intro.qmd"
  echo "Output created: _book/intro.html"
fi
sleep 30 &
exit 0
