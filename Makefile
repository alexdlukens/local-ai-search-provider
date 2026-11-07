UUID = ai-search@local
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install enable pack clean

all: schemas

schemas:
	glib-compile-schemas schemas

install: schemas
	mkdir -p $(EXTENSION_DIR)
	cp -r metadata.json extension.js prefs.js searchProvider.js lib schemas stylesheet.css README.md $(EXTENSION_DIR)/
	glib-compile-schemas $(EXTENSION_DIR)/schemas

enable: install
	gnome-extensions enable $(UUID)

pack: schemas
	rm -rf dist
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=searchProvider.js \
		--extra-source=lib \
		--extra-source=schemas \
		--extra-source=README.md \
		.

clean:
	rm -rf dist schemas/gschemas.compiled

uninstall:
	rm -rf $(EXTENSION_DIR)
