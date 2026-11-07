UUID = ai-search@local
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
APPLICATIONS_DIR = $(HOME)/.local/share/applications
DESKTOP_FILE = org.gnome.Shell.Extensions.AiSearch.Chat.desktop
GJS ?= $(shell command -v gjs || echo gjs)

.PHONY: all schemas install install-desktop enable pack clean

all: schemas

schemas:
	glib-compile-schemas schemas

install: schemas
	mkdir -p $(EXTENSION_DIR)
	cp -r metadata.json extension.js prefs.js chatWindow.js searchProvider.js lib schemas stylesheet.css README.md $(EXTENSION_DIR)/
	glib-compile-schemas $(EXTENSION_DIR)/schemas
	$(MAKE) install-desktop

install-desktop:
	mkdir -p $(APPLICATIONS_DIR)
	sed -e 's|@GJS@|$(GJS)|g' -e 's|@EXTENSION_DIR@|$(EXTENSION_DIR)|g' \
		data/$(DESKTOP_FILE).in > $(APPLICATIONS_DIR)/$(DESKTOP_FILE)
	-update-desktop-database $(APPLICATIONS_DIR) 2>/dev/null

enable: install
	gnome-extensions enable $(UUID)

pack: schemas
	rm -rf dist
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=searchProvider.js \
		--extra-source=chatWindow.js \
		--extra-source=lib \
		--schema=schemas/org.gnome.shell.extensions.ai-search.gschema.xml \
		--extra-source=README.md \
		.

clean:
	rm -rf dist schemas/gschemas.compiled

uninstall:
	rm -rf $(EXTENSION_DIR)
	rm -f $(APPLICATIONS_DIR)/$(DESKTOP_FILE)
	-update-desktop-database $(APPLICATIONS_DIR) 2>/dev/null
