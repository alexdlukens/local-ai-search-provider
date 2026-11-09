UUID = ai-search@alexdlukens.github.io
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
APPLICATIONS_DIR = $(HOME)/.local/share/applications
DESKTOP_FILE = org.gnome.Shell.Extensions.AiSearch.Chat.desktop
ICON_NAME = org.gnome.Shell.Extensions.AiSearch.Chat
ICON_SIZES = 16 24 32 48 64 128 256 512
ICON_THEME_DIR = $(HOME)/.local/share/icons/hicolor
ICONS_DIR = data/icons/hicolor
GJS ?= $(shell command -v gjs || echo gjs)

.PHONY: all schemas icons check install install-desktop enable pack clean uninstall

all: schemas

schemas:
	glib-compile-schemas schemas

icons:
	mkdir -p $(ICONS_DIR)/scalable/apps
	cp data/ai-search.svg $(ICONS_DIR)/scalable/apps/$(ICON_NAME).svg
	for size in $(ICON_SIZES); do \
		mkdir -p $(ICONS_DIR)/$${size}x$${size}/apps; \
		$(GJS) -c 'imports.gi.versions.GdkPixbuf = "2.0"; const GdkPixbuf = imports.gi.GdkPixbuf; const [src, dst, size] = ARGV; GdkPixbuf.Pixbuf.new_from_file_at_size(src, +size, +size).savev(dst, "png", [], []);' \
			data/ai-search.svg $(ICONS_DIR)/$${size}x$${size}/apps/$(ICON_NAME).png $$size; \
	done

check: schemas
	glib-compile-schemas --strict --dry-run schemas
	$(MAKE) pack

install: schemas
	mkdir -p $(EXTENSION_DIR)
	cp -r metadata.json extension.js prefs.js chatWindow.js searchProvider.js lib schemas stylesheet.css README.md LICENSE CHANGELOG.md SECURITY.md CONTRIBUTING.md docs $(EXTENSION_DIR)/
	glib-compile-schemas $(EXTENSION_DIR)/schemas
	$(MAKE) install-desktop

install-desktop:
	mkdir -p $(APPLICATIONS_DIR) $(ICON_THEME_DIR)/scalable/apps
	install -m 644 data/ai-search.svg $(ICON_THEME_DIR)/scalable/apps/$(ICON_NAME).svg
	for size in $(ICON_SIZES); do \
		mkdir -p $(ICON_THEME_DIR)/$${size}x$${size}/apps; \
		install -m 644 $(ICONS_DIR)/$${size}x$${size}/apps/$(ICON_NAME).png \
			$(ICON_THEME_DIR)/$${size}x$${size}/apps/$(ICON_NAME).png; \
	done
	sed -e 's|@GJS@|$(GJS)|g' -e 's|@EXTENSION_DIR@|$(EXTENSION_DIR)|g' \
		data/$(DESKTOP_FILE).in > $(APPLICATIONS_DIR)/$(DESKTOP_FILE)
	-gtk-update-icon-cache -f -t $(ICON_THEME_DIR) 2>/dev/null
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
		--extra-source=LICENSE \
		--extra-source=CHANGELOG.md \
		--extra-source=SECURITY.md \
		--extra-source=CONTRIBUTING.md \
		--extra-source=docs \
		.

clean:
	rm -rf dist schemas/gschemas.compiled

uninstall:
	rm -rf $(EXTENSION_DIR)
	rm -f $(APPLICATIONS_DIR)/$(DESKTOP_FILE)
	rm -f $(ICON_THEME_DIR)/scalable/apps/$(ICON_NAME).svg
	for size in $(ICON_SIZES); do \
		rm -f $(ICON_THEME_DIR)/$${size}x$${size}/apps/$(ICON_NAME).png; \
	done
	-gtk-update-icon-cache -f -t $(ICON_THEME_DIR) 2>/dev/null
	-update-desktop-database $(APPLICATIONS_DIR) 2>/dev/null
