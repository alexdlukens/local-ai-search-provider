# Publishing checklist

Use this before flipping the repository to public and before tagging a release.

## Pre-flight

- [ ] `make check` passes and produces
      `dist/ai-search@alexdlukens.github.io.shell-extension.zip`.
- [ ] `git status` is clean.
- [ ] No secrets, tokens, private endpoints, personal chat history, or local
      paths are tracked. Search the full history, not just the working tree:

      ```sh
      git log -p --all | grep -Ein "(api[_-]?key|secret|token|password|bearer)[[:space:]]*[:=]"
      ```

- [ ] The README opens with the AI-generated disclaimer.
- [ ] `metadata.json` has the public UUID, URL, and version name.
- [ ] Screenshots are ready for the listing: at least one overview and one
      chat-window image. extensions.gnome.org looks much better with both.
- [ ] Chats and settings used during testing are not committed.

## Make the repository public

Set the description, homepage, and topics while it is still private:

```sh
gh repo edit alexdlukens/local-ai-search-provider \
  --description "AI answers from a local OpenAI-compatible model in the GNOME Shell 50 overview." \
  --homepage "https://github.com/alexdlukens/local-ai-search-provider" \
  --add-topic gnome-shell-extension \
  --add-topic gnome-shell \
  --add-topic gnome \
  --add-topic ai \
  --add-topic llm \
  --add-topic ollama \
  --add-topic llama-cpp \
  --add-topic lm-studio \
  --add-topic mcp
```

Then change visibility in **Settings → General → Danger Zone**, or:

```sh
gh repo edit alexdlukens/local-ai-search-provider \
  --visibility public \
  --accept-visibility-change-consequences
```

After the repository is public:

- [ ] Enable **Private vulnerability reporting** under **Settings → Code
      security and analysis**, or:

      ```sh
      gh api -X PUT repos/alexdlukens/local-ai-search-provider/private-vulnerability-reporting
      ```

- [ ] Enable secret scanning and push protection for the repository (free for
      public repositories).
- [ ] Protect `master`: require pull requests, require the `check` workflow, and
      disallow force pushes.
- [ ] Confirm the `check` GitHub Actions workflow passes on the public repo.

## Tag a release

```sh
make check
git tag -a v0.1.0 -m "AI Search 0.1.0"
git push origin master
git push origin v0.1.0
gh release create v0.1.0 \
  dist/ai-search@alexdlukens.github.io.shell-extension.zip \
  --title "AI Search 0.1.0" \
  --notes-file CHANGELOG.md
```

Users can install the attached zip with:

```sh
gnome-extensions install --force ai-search@alexdlukens.github.io.shell-extension.zip
gnome-extensions enable ai-search@alexdlukens.github.io
```

## extensions.gnome.org (optional)

Before submitting, note the license conflict:

- The extensions.gnome.org upload form asks you to verify that the extension
  can be distributed under **GPL-2.0-or-later**.
- This project is licensed **GPL-3.0-or-later**. GPL-3.0-or-later code cannot be
  relicensed as GPL-2.0-or-later, so that checkbox cannot honestly be ticked
  without changing the license.
- If EGO publication is a goal, relicense to GPL-2.0-or-later (or dual-license)
  while you still own all the code, and update `LICENSE`, the README, and the
  contributing guide. Do this before accepting outside contributions.
- GitHub-only distribution is not affected by this requirement.

If the license question is resolved:

1. Log in at <https://extensions.gnome.org>.
2. Upload the zip from `make pack`.
3. Add a name, short description, and at least one screenshot.
4. Select GNOME Shell 50 and confirm the license statement.
5. Test the installed version from EGO, including preferences and the chat
   window.
6. Keep `metadata.json` `shell-version` accurate for later uploads.

## Post-public checks

- [ ] Open the repository in a private browser window and verify the README
      renders, links work, and images load.
- [ ] Clone from the public URL and follow the README install steps on a clean
      user account or VM.
- [ ] Verify `make uninstall` works from that clean clone.
- [ ] Check that the **AI Chats** desktop entry launches the chat window.
- [ ] Confirm the extension still enables after a logout/login cycle on
      Wayland.
- [ ] Review the first few external issues for missing prerequisites or unclear
      docs, and fold fixes back into `docs/USAGE.md`.
