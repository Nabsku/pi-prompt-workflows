# Changelog

## Unreleased

- Settle compaction barriers on Pi failure/cancellation events, including cancellations by other extensions. Preserve submitted-prompt ownership and reject ambiguous late terminals after timeout, abort, or overlapping attempts. Clarify fallback warnings without increasing the timeout.

## [0.20.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.19.1...v0.20.0) (2026-09-07)


### Features

* --loop execution, chain templates, fresh context, run-prompt tool ([4c8d202](https://github.com/Nabsku/pi-prompt-workflows/commit/4c8d202defa6fc105bf7cbc49c65183b890006e7))
* add /chain command for sequential template orchestration ([3370d98](https://github.com/Nabsku/pi-prompt-workflows/commit/3370d9805036c634bb9bb6f9aa86bf85e5e4f5a6))
* add adaptive chain schema ([513c53e](https://github.com/Nabsku/pi-prompt-workflows/commit/513c53e15aaba924428033d7a98bc2160db31269))
* add best-of-n commit ask mode ([4b678ab](https://github.com/Nabsku/pi-prompt-workflows/commit/4b678ab82e3886644266bbc5dcae452564e40fdd))
* add best-of-n preset resolution ([5f2050b](https://github.com/Nabsku/pi-prompt-workflows/commit/5f2050b1c002e3ec9652611a9e1469382e6e2187))
* add best-of-n run reports ([9639a3a](https://github.com/Nabsku/pi-prompt-workflows/commit/9639a3add69fe863d21a323aa1ff8a5504678f3d))
* add boomerang prompt templates ([94dc14f](https://github.com/Nabsku/pi-prompt-workflows/commit/94dc14f8512b0f098cb6f7e65088ed81a71eba22))
* add bounded adaptive chain routing ([2bd32e4](https://github.com/Nabsku/pi-prompt-workflows/commit/2bd32e40d5e92b481bba3b99fce632c92ec84da1))
* add compare dry-run and inspection UI ([6fbd86f](https://github.com/Nabsku/pi-prompt-workflows/commit/6fbd86f43274c2f7014d4bb2b943f6fb2cf82e3d))
* add compare operability foundation ([0134427](https://github.com/Nabsku/pi-prompt-workflows/commit/0134427017dbc4f1c0df369c85e1f9ae92221bbb))
* add compare preflight and preset discovery ([f521b16](https://github.com/Nabsku/pi-prompt-workflows/commit/f521b16b0b8fe36865b5e75d89ea77a64568af79))
* add compare run history command ([d78479d](https://github.com/Nabsku/pi-prompt-workflows/commit/d78479d15052db0cd4c0514cb6f16b91035566ec))
* add cwd frontmatter and --cwd runtime flag for subagent delegation ([0d77f75](https://github.com/Nabsku/pi-prompt-workflows/commit/0d77f757f487a2f0400fffbd90b14297196729ef))
* add delegated subagent execution via event bus ([c1c1626](https://github.com/Nabsku/pi-prompt-workflows/commit/c1c16260c3144fb2c8a82a7fd7b7b964b26de6b9))
* add deterministic prompt steps ([4902080](https://github.com/Nabsku/pi-prompt-workflows/commit/4902080dee2c4bfd9d7368bfeded2c929b6a87a1))
* add includes pane to dry-run TUI ([c2d5a5d](https://github.com/Nabsku/pi-prompt-workflows/commit/c2d5a5d7a930adc2eb6d3e2f2fe86bde0b878621))
* add multi-skill prompt frontmatter ([9762376](https://github.com/Nabsku/pi-prompt-workflows/commit/9762376321dccb090e3d8359fce9b4b00a0497d4))
* add parallel() chain step support for delegated prompt templates ([8d6ee16](https://github.com/Nabsku/pi-prompt-workflows/commit/8d6ee16d637337bef0c22b5a9fe433a09136f940))
* add prompt budget estimates ([f162e8b](https://github.com/Nabsku/pi-prompt-workflows/commit/f162e8bcef55c43a26a36bf2c37b15f98aeaeb4f))
* add prompt dry-run commands ([f38caf0](https://github.com/Nabsku/pi-prompt-workflows/commit/f38caf0cc6af615e5a9bb8c1284fe112d1a988c8))
* add prompt dry-run core ([fb7b6aa](https://github.com/Nabsku/pi-prompt-workflows/commit/fb7b6aa7124af5959501a22fb0d5c3d599730fab))
* add prompt dry-run TUI ([312441d](https://github.com/Nabsku/pi-prompt-workflows/commit/312441d4e292d9bf06d3cb0c39e200881493ace8))
* add prompt includes ([d3fb3ea](https://github.com/Nabsku/pi-prompt-workflows/commit/d3fb3ea998a494b9acc62bb2d4303db7afa6895a))
* add prompt validation command ([63400ba](https://github.com/Nabsku/pi-prompt-workflows/commit/63400ba4f95b1723599a201a42c6c4c7f6e5446b))
* add prompt-templates agent skill ([191ab16](https://github.com/Nabsku/pi-prompt-workflows/commit/191ab16d4184daac70b759f5c54b216f761ccc57))
* add skill injection and subdirectory support ([536fdb3](https://github.com/Nabsku/pi-prompt-workflows/commit/536fdb3288317aa70a6bdfa0724d0c78c7b38bf7))
* add thinking level control and print mode support ([a406a35](https://github.com/Nabsku/pi-prompt-workflows/commit/a406a35bc375824df0143f5ff68c183dbe30d6bd))
* add typed prompt inputs ([a715e09](https://github.com/Nabsku/pi-prompt-workflows/commit/a715e09fb834b43363828ad5a5ddb639d936a27c))
* add verified worktree change snapshots ([2024eea](https://github.com/Nabsku/pi-prompt-workflows/commit/2024eea457612859e4766f0924fc5022a521f9e3))
* attach include graphs to dry runs ([7beca8d](https://github.com/Nabsku/pi-prompt-workflows/commit/7beca8d54eb7a5eb308962b5dbbe6af34afab842))
* attach include graphs to validation ([79287ef](https://github.com/Nabsku/pi-prompt-workflows/commit/79287ef24612bee9ce293d2db988795ade8cc1cb))
* chain context summaries for delegated steps ([85d06fd](https://github.com/Nabsku/pi-prompt-workflows/commit/85d06fda6bc0bfc9797ac87eaa44f41b0d3dc960))
* collect missing prompt inputs in TUI ([3c80fb4](https://github.com/Nabsku/pi-prompt-workflows/commit/3c80fb4081c6c3a45444bcb5507e0a410a5596de))
* collect prompt include graphs ([96e9be4](https://github.com/Nabsku/pi-prompt-workflows/commit/96e9be4214c137c1955af4dfcebf3cb43081a822))
* collect prompt source records ([d6d1a7b](https://github.com/Nabsku/pi-prompt-workflows/commit/d6d1a7b7d824f4350d7c7274ffc0d63904d73db6))
* discover prompt-library roots ([285fb7c](https://github.com/Nabsku/pi-prompt-workflows/commit/285fb7cb4b47e68a7767e0512f4bef346aa1c61a))
* enforce and report prompt budgets ([4011508](https://github.com/Nabsku/pi-prompt-workflows/commit/4011508ea256b9a9220128b30b4a7062c4b63c51))
* execute bounded adaptive chains ([9a265d2](https://github.com/Nabsku/pi-prompt-workflows/commit/9a265d2fe496ee6aa260071bdecc008477a0fd4c))
* expose prompt include parsing helpers ([2e9f7d9](https://github.com/Nabsku/pi-prompt-workflows/commit/2e9f7d9ab8aa1f7ec2ba3824d1dd966d0ca7f764))
* harden delegated compare workflows ([829d5ea](https://github.com/Nabsku/pi-prompt-workflows/commit/829d5eaafd86f72953d2fd9cbe7c7dbda217983b))
* hide internal prompt-library commands ([8e60435](https://github.com/Nabsku/pi-prompt-workflows/commit/8e60435188debdfbbcf152af959a48439f158165))
* improve compare UX guidance ([f8a5fb8](https://github.com/Nabsku/pi-prompt-workflows/commit/f8a5fb8340a1517ce5a115d9f52d2b5aead36bb3))
* inject delegated results into parent conversation ([fe15001](https://github.com/Nabsku/pi-prompt-workflows/commit/fe1500184cae50ae251f09ea5f87f713b0b24a52))
* inline model conditionals and modular refactor ([e8d4f89](https://github.com/Nabsku/pi-prompt-workflows/commit/e8d4f89d0fd941011b28d2619f1c369188d3e3cc))
* inspect adaptive chain execution ([c5a418e](https://github.com/Nabsku/pi-prompt-workflows/commit/c5a418e6e55d01ef35d43b67f32f0a7bed3bc35a))
* model fallback with comma-separated model lists ([56fb151](https://github.com/Nabsku/pi-prompt-workflows/commit/56fb15169410992b47c7afff90a9467e2cffd3e7))
* normalize adaptive step outcomes ([3fb34bd](https://github.com/Nabsku/pi-prompt-workflows/commit/3fb34bd99e72f7c6ae196e699a4816a72d4e400e))
* polish compare run history recovery ([1611414](https://github.com/Nabsku/pi-prompt-workflows/commit/1611414305e5a87039c1f83e616648ae9ff3f5a2))
* polish prompt-library UX ([fa980c7](https://github.com/Nabsku/pi-prompt-workflows/commit/fa980c70c6d300711d20d149ed6c43214eac74ba))
* port low-risk upstream parity slices ([85e93b0](https://github.com/Nabsku/pi-prompt-workflows/commit/85e93b0cf4327a6e457625acb6b45ca29dc203be))
* rename /chain to /chain-prompts, add per-step args ([4d00f57](https://github.com/Nabsku/pi-prompt-workflows/commit/4d00f5779eda57fbf2ce1e943ed7c623fe390e7b))
* render input and model conditionals together ([150f4ff](https://github.com/Nabsku/pi-prompt-workflows/commit/150f4ff22d62ab8e9463ae65a0b29000c5eaad28))
* render prompt dry-run output ([bb7260f](https://github.com/Nabsku/pi-prompt-workflows/commit/bb7260f95e4addbf6ebf4315a8f12664253e8a86))
* report prompt include graphs ([55814f9](https://github.com/Nabsku/pi-prompt-workflows/commit/55814f9d0ae48ac6aeefb59594b71506475220cd))
* resolve includes from prompt-library ([b403205](https://github.com/Nabsku/pi-prompt-workflows/commit/b403205d177ce2fb7e41e9e7540c89f29f72c321))
* restore structured best-of-n delegation ([39a514e](https://github.com/Nabsku/pi-prompt-workflows/commit/39a514e792ea401e69f2998988873c440615c888))
* run prompt-library templates ([34dfbb0](https://github.com/Nabsku/pi-prompt-workflows/commit/34dfbb05b757cb18796afba6c6ddd2c5a1561b14))
* runtime flags, unlimited loops, model rotation, abort detection, loop context prefix ([59e22cf](https://github.com/Nabsku/pi-prompt-workflows/commit/59e22cf8180f638566e86d93a4bda438a963da15))
* ship best-of-n compare workflows ([c0f1cd4](https://github.com/Nabsku/pi-prompt-workflows/commit/c0f1cd4180111f4878ec010721fb18bedceb08f7))
* support loop: unlimited frontmatter for open-ended loops ([da5c061](https://github.com/Nabsku/pi-prompt-workflows/commit/da5c061d599ea62141a3493cf1bc2a72c3b0d8c0))
* support model-less prompts and deterministic chain inheritance ([42041fa](https://github.com/Nabsku/pi-prompt-workflows/commit/42041faee2b189d9e008c45f955937db70ed88bd))
* tighten compare run recovery UX ([6187486](https://github.com/Nabsku/pi-prompt-workflows/commit/6187486702d72dde2a077f5bb35c3ae0e3252ce5))
* validate and document adaptive chains ([7a1e5d9](https://github.com/Nabsku/pi-prompt-workflows/commit/7a1e5d9f04743e43b7806f362fffaba1c94ac490))
* validate prompt-library templates ([a4543fa](https://github.com/Nabsku/pi-prompt-workflows/commit/a4543fa2587d3af8c9c083b0c8af8869ba7a3aa4))


### Bug Fixes

* add promptSnippet for run-prompt tool ([ccaef96](https://github.com/Nabsku/pi-prompt-workflows/commit/ccaef96414f2bf12f0b364b43b6da6301c48635c))
* address best-of-n preset review comments ([5d695a9](https://github.com/Nabsku/pi-prompt-workflows/commit/5d695a97e3e3257b1a3179a6aff804ecbbe86124))
* address compare recovery review feedback ([aa14f95](https://github.com/Nabsku/pi-prompt-workflows/commit/aa14f95b4f382e62ae056e6a75b666a3cf32265f))
* address compare review recovery commands ([2be36fb](https://github.com/Nabsku/pi-prompt-workflows/commit/2be36fbfa0622ade5a2b03a03688e3a725dcd06c))
* address dry-run TUI review feedback ([052c495](https://github.com/Nabsku/pi-prompt-workflows/commit/052c495da3557c3e702c5c74740d6a537f30f56e))
* address prompt-library review comments ([afdfda1](https://github.com/Nabsku/pi-prompt-workflows/commit/afdfda1815a8470db00ba648492d46f9c80e3bc2))
* align adaptive Git observation ([5a3ce1e](https://github.com/Nabsku/pi-prompt-workflows/commit/5a3ce1e3a5dcb1432e2149bab0ccdc0c07125e47))
* align adaptive preflight state ([5c4b878](https://github.com/Nabsku/pi-prompt-workflows/commit/5c4b878374472fc0102358122f267804425b2d7f))
* align adaptive runtime semantics ([17c342c](https://github.com/Nabsku/pi-prompt-workflows/commit/17c342c6ab4e123c751de92367ff6d5e69f7243e))
* align budget preflight with runtime ([79d3ed8](https://github.com/Nabsku/pi-prompt-workflows/commit/79d3ed82969788a75501125aac5a3b0faebfd62b))
* align budget validation edge cases ([4b9c23b](https://github.com/Nabsku/pi-prompt-workflows/commit/4b9c23b0b0fd7f21f066d31150c73e7be345806c))
* align compare dry-run preflight parity ([baeb34d](https://github.com/Nabsku/pi-prompt-workflows/commit/baeb34d33f23dd4af01c4c53f735de8a32ec6b4d))
* align compare preflight with runtime ([218264a](https://github.com/Nabsku/pi-prompt-workflows/commit/218264a11bebe25c413c5af0c3a46d0943b77306))
* align prompt dry-run loop metadata ([998f6ea](https://github.com/Nabsku/pi-prompt-workflows/commit/998f6eaf597401e6280eaf9556d7e4d9c176f245))
* align workflows extension with upstream v0.10.0 ([e6beaf9](https://github.com/Nabsku/pi-prompt-workflows/commit/e6beaf97a48c8feaf1ddaf5c7456c44d2dc52273))
* allow skills in delegated prompts ([0be8e53](https://github.com/Nabsku/pi-prompt-workflows/commit/0be8e5342b0499dcfbd17c9fce6ba09e4670eb43))
* allow thinking-only library prompts ([afb18fa](https://github.com/Nabsku/pi-prompt-workflows/commit/afb18fad534f8be902a5f15d3e1fb372f93f68b2))
* avoid duplicate include graph diagnostics ([9ed9780](https://github.com/Nabsku/pi-prompt-workflows/commit/9ed978013765a8b8647827ab040717c12b1b8f93))
* bound adaptive snapshot analysis ([3c617d7](https://github.com/Nabsku/pi-prompt-workflows/commit/3c617d758b526d61b7eb15bd8b653481feac5c13))
* classify broken library commands in summary ([18b31df](https://github.com/Nabsku/pi-prompt-workflows/commit/18b31df5467c1f459e388d9c92a1c8ca8f464181))
* close adaptive execution gaps ([ccdac73](https://github.com/Nabsku/pi-prompt-workflows/commit/ccdac73893bac6eeddf926e34039c22c07bd01aa))
* close adaptive lifecycle edge cases ([627f296](https://github.com/Nabsku/pi-prompt-workflows/commit/627f296695cc9cc7b4ddace733a9f1cd37052628))
* close adaptive review gaps ([728b5f9](https://github.com/Nabsku/pi-prompt-workflows/commit/728b5f9207b61425e6ef5a8d901571197e15ea51))
* close adaptive state edge cases ([2d48437](https://github.com/Nabsku/pi-prompt-workflows/commit/2d48437f8c35e0ea44efd94de5870d1b3d42154f))
* close best-of-n review gaps ([500f457](https://github.com/Nabsku/pi-prompt-workflows/commit/500f457f0521ea23560cbd716f158d529f805e61))
* close best-of-n target and evidence gaps ([57fca9c](https://github.com/Nabsku/pi-prompt-workflows/commit/57fca9cd6ee33389e0a690c00156091470701a0f))
* close commit approval review gaps ([9b92858](https://github.com/Nabsku/pi-prompt-workflows/commit/9b92858297254d572772a229234a916308379d44))
* close compare UX blocker gaps ([a18a7c3](https://github.com/Nabsku/pi-prompt-workflows/commit/a18a7c37d20cd005abd5de965367b6fba604bb6b))
* close follow-up compare review gaps ([e0920d2](https://github.com/Nabsku/pi-prompt-workflows/commit/e0920d2934b737f5f58b79c748c75446ff8523cf))
* close parity review gaps ([881e99f](https://github.com/Nabsku/pi-prompt-workflows/commit/881e99f71ffa11f31923b4e18cfbcc3c5e646754))
* close preset review edge cases ([e426ff6](https://github.com/Nabsku/pi-prompt-workflows/commit/e426ff65056a5a206c58bf21a3c4b7be8f995150))
* close preset validation review gaps ([5ae8719](https://github.com/Nabsku/pi-prompt-workflows/commit/5ae87196af1b561346cf48e5edf415608a42ecc3))
* close rebased codex findings ([a5175d2](https://github.com/Nabsku/pi-prompt-workflows/commit/a5175d29690eb9111cfc0ca1cebe20686a1be7a3))
* close remaining best-of-n review gaps ([95e9add](https://github.com/Nabsku/pi-prompt-workflows/commit/95e9adde384bfbe81b01efa432de8150bab424bd))
* close remaining best-of-n review gaps ([1a0fac9](https://github.com/Nabsku/pi-prompt-workflows/commit/1a0fac9a988c88197116e0e073b62ad688eea1fa))
* close remaining budget validation gaps ([1db87a8](https://github.com/Nabsku/pi-prompt-workflows/commit/1db87a810179bf1ae9693d98f13f576c2b2f8326))
* close remaining codex input review gaps ([bb9f08c](https://github.com/Nabsku/pi-prompt-workflows/commit/bb9f08c9174244f71dbcacea91703a9c2730da6d))
* close remaining interactive input review gaps ([e6ebb36](https://github.com/Nabsku/pi-prompt-workflows/commit/e6ebb36c51e0bd66c385d3206e70a76726592edc))
* complete adaptive chain inspection ([cb4c3be](https://github.com/Nabsku/pi-prompt-workflows/commit/cb4c3be5fe9b7526c412a6ce11ca6866fe45c8fc))
* complete adaptive snapshot identity ([f654e94](https://github.com/Nabsku/pi-prompt-workflows/commit/f654e94833292b909baf5c6befbc3c2e2173cf90))
* complete adaptive submodule evidence ([0b8f5b5](https://github.com/Nabsku/pi-prompt-workflows/commit/0b8f5b5d272d08bf1cbd709fb03fadc837489981))
* complete final input review findings ([094a953](https://github.com/Nabsku/pi-prompt-workflows/commit/094a9535061b00bd9cdbd544b973cc4d5addeda4))
* complete static budget preflight ([23cccb6](https://github.com/Nabsku/pi-prompt-workflows/commit/23cccb6fbc72b2b17473d346051f359c9a65963c))
* correct prompt-library source summary ([e6c9ddc](https://github.com/Nabsku/pi-prompt-workflows/commit/e6c9ddc1a6ef92a59640a5386d3e0f574f30e24e))
* count empty-model library commands ([0c0c0dc](https://github.com/Nabsku/pi-prompt-workflows/commit/0c0c0dcd854409cf6c86540cd563ee642dcfdfb9))
* count invalid library command markers ([9e267b9](https://github.com/Nabsku/pi-prompt-workflows/commit/9e267b934a2d1989725aa9df98921eb27a4fdc1b))
* count shadowed library commands ([acacdbb](https://github.com/Nabsku/pi-prompt-workflows/commit/acacdbbd291d4e48db5732a3ec6e3f0a59cad2c7))
* count skipped library command entries ([2692323](https://github.com/Nabsku/pi-prompt-workflows/commit/26923233925fff36044240f7e8a601d20627aa03))
* cover dirty approval edge cases ([cd1f576](https://github.com/Nabsku/pi-prompt-workflows/commit/cd1f576b838d67c5fe197419fd9c77257ab49547))
* defer conditional budget validation ([9f9dd88](https://github.com/Nabsku/pi-prompt-workflows/commit/9f9dd88224bd99ab7b5dca2fb441ae905f6a9d64))
* detect dirty approval changes precisely ([0dfd707](https://github.com/Nabsku/pi-prompt-workflows/commit/0dfd70759936f75b6a9d627609a1c3c3a1673187))
* discover nested pi-subagents runtimes ([bb16d4e](https://github.com/Nabsku/pi-prompt-workflows/commit/bb16d4e78e1105733afd191d40d60e92f095dd5b))
* discover pi-subagents runtime installs ([cd3f9bd](https://github.com/Nabsku/pi-prompt-workflows/commit/cd3f9bd45cb44076e2dad802907f3d5a67b868bd))
* enforce budgets on dispatched prompts ([4a805a0](https://github.com/Nabsku/pi-prompt-workflows/commit/4a805a018d0b2afe09a0c151b3f758f1395934cd))
* fence best-of-n source baseline ([d207b61](https://github.com/Nabsku/pi-prompt-workflows/commit/d207b612388ae72f77271bf80893cf8f5c50fdf4))
* finish best-of-n review corrections ([5d397b2](https://github.com/Nabsku/pi-prompt-workflows/commit/5d397b20062210ce9c33c7485a8870621c82ea62))
* handle approval review edge cases ([45b0fe2](https://github.com/Nabsku/pi-prompt-workflows/commit/45b0fe2218f0a5584a1fd058a76379c86ebd1a54))
* harden adaptive path snapshots ([c8488cc](https://github.com/Nabsku/pi-prompt-workflows/commit/c8488cc6fef8d2b5dcb60bb23ee1d20dcdaf9ada))
* harden best-of-n commit approval ([fb07a75](https://github.com/Nabsku/pi-prompt-workflows/commit/fb07a755ae742b5dfffa98d6450a4d3089f0cea0))
* harden best-of-n commit ask handoff ([b64f62e](https://github.com/Nabsku/pi-prompt-workflows/commit/b64f62e6cef07f2290a5a77e95d3745a8db17561))
* harden best-of-n delegation contracts ([218f459](https://github.com/Nabsku/pi-prompt-workflows/commit/218f4595b7e6f46602c53762bdc16ccf78c7e96e))
* harden best-of-n preset overrides ([404e687](https://github.com/Nabsku/pi-prompt-workflows/commit/404e6877d7c7c7da3566f20bfdb3ce95156b6cb6))
* harden best-of-n report artifacts ([cdede4e](https://github.com/Nabsku/pi-prompt-workflows/commit/cdede4e1bae48cc4499a326d1816e2235ce981bc))
* harden best-of-n request inputs ([48de109](https://github.com/Nabsku/pi-prompt-workflows/commit/48de1091144d5aa89f8cd602a2781a24d7989c9e))
* harden compare preset and run lookups ([3e93d5f](https://github.com/Nabsku/pi-prompt-workflows/commit/3e93d5febd7e10df4133a18906a6f121ce00529c))
* harden hidden prompt-library commands ([fa72cb5](https://github.com/Nabsku/pi-prompt-workflows/commit/fa72cb51e17e91c1d5dcbbe6313379ac0cadf9b1))
* harden input workflow and argument handling ([3a7c828](https://github.com/Nabsku/pi-prompt-workflows/commit/3a7c828db376c6780ed49b29a25606eec89467c3))
* harden interactive prompt input boundaries ([53934d8](https://github.com/Nabsku/pi-prompt-workflows/commit/53934d8c283f55e7486ad13b1deae36df2c8065b))
* harden project preset resolution ([b0fa66f](https://github.com/Nabsku/pi-prompt-workflows/commit/b0fa66f5aec3cbd46dc267f9d54755485dc7115e))
* harden prompt execution lifecycle ([bc3c196](https://github.com/Nabsku/pi-prompt-workflows/commit/bc3c1963ddef289d144de9eadc4c294e65c82078))
* harden prompt-library loading ([0238c60](https://github.com/Nabsku/pi-prompt-workflows/commit/0238c6016329713fb1b7be31959388c3aa6b545d))
* harden prompt-library parity coverage ([72a090e](https://github.com/Nabsku/pi-prompt-workflows/commit/72a090e1a6944498669c64e590800b854e8ab688))
* honor project trust and nested runtime discovery ([756102c](https://github.com/Nabsku/pi-prompt-workflows/commit/756102c6f5457097ef2706f9005467202ca40ee7))
* honor q as prompt input cancellation ([9216f4a](https://github.com/Nabsku/pi-prompt-workflows/commit/9216f4aa731b32488ac4f42433b98d325423dc2f))
* isolate adaptive snapshot probes ([3bc1d5c](https://github.com/Nabsku/pi-prompt-workflows/commit/3bc1d5c8323dcbc595f5bd52c00466823de67bbe))
* isolate best-of-n delegated workspaces ([1dfae75](https://github.com/Nabsku/pi-prompt-workflows/commit/1dfae7574de968e68a708993dbfb4f6576b59545))
* keep adaptive validation read-only ([c1174bf](https://github.com/Nabsku/pi-prompt-workflows/commit/c1174bf6d7c0e78a8c9ad382a8f1e06fe7c74db7))
* keep ignored prompt-library fragments quiet ([b5dae2d](https://github.com/Nabsku/pi-prompt-workflows/commit/b5dae2dab54c6b7c9e022ab804c17d6d45144228))
* keep input value replacement non-recursive ([7e82d65](https://github.com/Nabsku/pi-prompt-workflows/commit/7e82d6525422df48f7c5e89d21fa001c1e3e802c))
* keep prompt dry-run out of history ([00f7d80](https://github.com/Nabsku/pi-prompt-workflows/commit/00f7d80aedfbbbd17005567f6a68a473f86baf00))
* keep prompt-library fragments inert ([190de63](https://github.com/Nabsku/pi-prompt-workflows/commit/190de630ed81045b2465b194ee21078b85ab809b))
* keep prompt-library fragments quiet ([93de95a](https://github.com/Nabsku/pi-prompt-workflows/commit/93de95aef14568e8acea1e8611f7311962fa77d1))
* limit interactive input repairs ([91dcc0b](https://github.com/Nabsku/pi-prompt-workflows/commit/91dcc0be85b4f9a47aaff054f04ab769b0bd516b))
* make adaptive snapshots semantically stable ([fd00077](https://github.com/Nabsku/pi-prompt-workflows/commit/fd00077cb31b1251b48e434d0df9b67b6f4cad0d))
* make input cancellation side-effect free ([6f9310f](https://github.com/Nabsku/pi-prompt-workflows/commit/6f9310f95e20993e2bccd1342263fef2ccb509d2))
* package Git environment helper ([8eaee39](https://github.com/Nabsku/pi-prompt-workflows/commit/8eaee396f0a864de6e0e542244f240392ed36604))
* parse quoted runtime flag values ([0a8841c](https://github.com/Nabsku/pi-prompt-workflows/commit/0a8841cae29a074074ba1e007ea7acd1dd7d56b9))
* polish prompt template skill docs ([3007228](https://github.com/Nabsku/pi-prompt-workflows/commit/30072280d717330b43455ba6b57d7d95dd12949d))
* polish TUI rendering edge cases ([d55580b](https://github.com/Nabsku/pi-prompt-workflows/commit/d55580b514dfb6373635136b99d2802ecde38338))
* preflight prompt-library chain approval ([6091be0](https://github.com/Nabsku/pi-prompt-workflows/commit/6091be0fa179cc266dd9dd5089ba8e0d65e7c2cb))
* preserve adaptive execution evidence ([a6ab887](https://github.com/Nabsku/pi-prompt-workflows/commit/a6ab88716d09db2ec0e870764c4ca478d8985298))
* preserve adaptive index semantics ([911eb4c](https://github.com/Nabsku/pi-prompt-workflows/commit/911eb4c075f1c3eeb4bc5f01ff1621a0e0276f6c))
* preserve adaptive route guards ([fd5feaf](https://github.com/Nabsku/pi-prompt-workflows/commit/fd5feafdc0e26030ea789ab632c8bcd0e883ed1d))
* preserve adaptive routing semantics ([22058c5](https://github.com/Nabsku/pi-prompt-workflows/commit/22058c5b998bdd6d968762ad5204322c7a3b486a))
* preserve best-of-n candidates on cancellation ([ea910fd](https://github.com/Nabsku/pi-prompt-workflows/commit/ea910fd8d7665f82e514d52c01d1cb3deab8d4f2))
* preserve best-of-n lineup task metadata ([35cffd6](https://github.com/Nabsku/pi-prompt-workflows/commit/35cffd62e6472c95603e51349c703b706f009594))
* preserve best-of-n slot identity ([2ee2480](https://github.com/Nabsku/pi-prompt-workflows/commit/2ee24809e0f9c7404f59c108d78f727c6e2f0372))
* preserve commit ask git status columns ([c85319e](https://github.com/Nabsku/pi-prompt-workflows/commit/c85319ec8f7a802a7c19029e5da550345d500eb8))
* preserve compare history cwd in recovery UI ([fb7e701](https://github.com/Nabsku/pi-prompt-workflows/commit/fb7e701f77b15e020b2277ebae79feda414d3cc1))
* preserve Git output limit errors ([fcddb06](https://github.com/Nabsku/pi-prompt-workflows/commit/fcddb06be7289701271a6a3af73d38a16aa15828))
* preserve input boundary semantics ([fdb55aa](https://github.com/Nabsku/pi-prompt-workflows/commit/fdb55aa2145fe92ffba598ee44e271a93964b150))
* preserve skipped include graphs for overrides ([de5b3f2](https://github.com/Nabsku/pi-prompt-workflows/commit/de5b3f221e7ca1fb8eba4085a5215d009b81825e))
* prevent invalid project presets from falling through ([97c7034](https://github.com/Nabsku/pi-prompt-workflows/commit/97c703403aed0c80b04d09d9f2d4e2a23d1d5bdd))
* publish after release-please releases ([89e9661](https://github.com/Nabsku/pi-prompt-workflows/commit/89e9661de3037951d121b8a714d91f3d2bff1360))
* record actual best-of-n delegated tasks ([d409faf](https://github.com/Nabsku/pi-prompt-workflows/commit/d409faf4c13a69522cd0af7ef7bb15f43f95cfc0))
* record effective best-of-n tasks ([30765e9](https://github.com/Nabsku/pi-prompt-workflows/commit/30765e94916767e5120dc174c11b14b3359b1e1f))
* refine input form cancellation and diagnostics ([346ceaa](https://github.com/Nabsku/pi-prompt-workflows/commit/346ceaa947b5fd4bb353832139921375aeb8de88))
* reject hidden best-of-n source state ([01bf59f](https://github.com/Nabsku/pi-prompt-workflows/commit/01bf59f7bdaf1199b96887f4110e0de75955bcf1))
* reject inherited context in best-of-n prompts ([30ca117](https://github.com/Nabsku/pi-prompt-workflows/commit/30ca11777dd9ebe9ff2b19d1826357de4fcea5a0))
* report adaptive observations honestly ([bb816ea](https://github.com/Nabsku/pi-prompt-workflows/commit/bb816eaab3d262de5143640dd302c2a3f56eecf1))
* restore thinking level after model-only prompt commands ([d5090f2](https://github.com/Nabsku/pi-prompt-workflows/commit/d5090f2963295459b28435eb9048b103819a14d5))
* retain adaptive snapshot settings ([04bf487](https://github.com/Nabsku/pi-prompt-workflows/commit/04bf487cc0cd89e9e88a7cf8af804d435041efba))
* settle cancelled compaction barriers ([33363e5](https://github.com/Nabsku/pi-prompt-workflows/commit/33363e5046229825613dd7b4fa6803ee6278cba7))
* stabilize adaptive snapshots and cleanup ([93c8502](https://github.com/Nabsku/pi-prompt-workflows/commit/93c850293b285ea42d6533f3a015d52f0e2d8ec5))
* **subagent:** defer model resolution for model-less prompts ([724d9a4](https://github.com/Nabsku/pi-prompt-workflows/commit/724d9a4af9772ce03d1e467e11103c58a31fa161))
* **subagent:** defer model-less prompt rendering ([28f3021](https://github.com/Nabsku/pi-prompt-workflows/commit/28f30211a04a6190218c4364da0a4952a97141a5))
* summarize rendered static budgets ([b5285b7](https://github.com/Nabsku/pi-prompt-workflows/commit/b5285b758aadc2791080c7f0049c78cbb386d975))
* support Kitty inspector controls ([ceb28aa](https://github.com/Nabsku/pi-prompt-workflows/commit/ceb28aab79621920aae7cbef63192a0d1d3e6de2))
* support Kitty picker input ([9c590ae](https://github.com/Nabsku/pi-prompt-workflows/commit/9c590ae756d2859e2f8d3057ac157bb13ccf0333))
* support nested provider model ids ([7ac1041](https://github.com/Nabsku/pi-prompt-workflows/commit/7ac10412b3d43279656df35da90dc59120059d93))
* support pi 0.65 runtime changes ([d8eac33](https://github.com/Nabsku/pi-prompt-workflows/commit/d8eac3361408e268f3c935e22c6a043a7eaa8d9b))
* support plain prompt chain resolution ([57353b9](https://github.com/Nabsku/pi-prompt-workflows/commit/57353b9fe9f583e8f00234271d6e9d65389d25a4))
* suppress rewind prompt for boomerang templates ([4b91f77](https://github.com/Nabsku/pi-prompt-workflows/commit/4b91f7727fb9b8f7c00d26d21356837b9592a720))
* sync upstream prompt workflows ([3d9a19a](https://github.com/Nabsku/pi-prompt-workflows/commit/3d9a19a0f263c51de6773e710b9651b5af9dd62f))
* sync upstream safety and progress safeguards ([a7fb304](https://github.com/Nabsku/pi-prompt-workflows/commit/a7fb304693b5eea028e7ff44ea3692726ea82bf9))
* tighten prompt-library trust boundaries ([ed8cba9](https://github.com/Nabsku/pi-prompt-workflows/commit/ed8cba988e07782877f2076287d77c3e8675e6ef))
* update skill command resolution for pi-coding-agent 0.62.0 sourceInfo changes ([74ed8dd](https://github.com/Nabsku/pi-prompt-workflows/commit/74ed8dd57923fe039d11e5c8d22443ff722a1f66))
* use raw git diff capture for approval ([92cdd3a](https://github.com/Nabsku/pi-prompt-workflows/commit/92cdd3a81853a22631a54375869e43e9c5f799c0))
* validate budgets against pinned models ([631eb3b](https://github.com/Nabsku/pi-prompt-workflows/commit/631eb3b244d6e146ee9fbf4f14e57e182b2e0cb2))
* validate input references and dry-run args ([82379b8](https://github.com/Nabsku/pi-prompt-workflows/commit/82379b843135d6c77bba395e700e73db4bb7e791))
* validate presets from prompt cwd ([834a911](https://github.com/Nabsku/pi-prompt-workflows/commit/834a91152b8c48ba0ccd69ec378ad24cb51858ad))
* validate prompt input references ([cd1cd65](https://github.com/Nabsku/pi-prompt-workflows/commit/cd1cd65a1ef8bf52c358b229fb171c505f7865b0))
* wire resolved inputs into prompt rendering ([47e4b74](https://github.com/Nabsku/pi-prompt-workflows/commit/47e4b748d485d658723208bb84117ce04f8b6163))

## [0.19.1](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.19.0...v0.19.1) (2026-09-06)


### Bug Fixes

* settle cancelled compaction barriers ([f3eca44](https://github.com/Nabsku/pi-prompt-workflows/commit/f3eca444b34122ff9ac6bfe010e80e809b27e1b5))

## [0.19.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.18.2...v0.19.0) (2026-08-31)


### Features

* restore structured best-of-n delegation ([47a0e9c](https://github.com/Nabsku/pi-prompt-workflows/commit/47a0e9ce148e19ded5f50b54caa36d3de23e6093))


### Bug Fixes

* close best-of-n review gaps ([a4f36c8](https://github.com/Nabsku/pi-prompt-workflows/commit/a4f36c8cd13859dfb3a469a5360b5ecb92efd952))
* close best-of-n target and evidence gaps ([7e5e3f5](https://github.com/Nabsku/pi-prompt-workflows/commit/7e5e3f5d1adfcf61d3a0b6a46eccb2703f045578))
* close remaining best-of-n review gaps ([2200e78](https://github.com/Nabsku/pi-prompt-workflows/commit/2200e782066c6743f813cb080497ec48a6d87bcf))
* close remaining best-of-n review gaps ([35a33f1](https://github.com/Nabsku/pi-prompt-workflows/commit/35a33f19f9ba79dceaed8d7441f2376547a622b7))
* fence best-of-n source baseline ([aba3163](https://github.com/Nabsku/pi-prompt-workflows/commit/aba316307d91167c7b4aca9ec136b65da7d7dd84))
* finish best-of-n review corrections ([a430d97](https://github.com/Nabsku/pi-prompt-workflows/commit/a430d97e2f2a1e03df29b2904467cd8541536576))
* harden best-of-n delegation contracts ([363d19f](https://github.com/Nabsku/pi-prompt-workflows/commit/363d19f81e261bff28d1fbd1f7b6c294ea3f5ec5))
* harden best-of-n request inputs ([ddfe47f](https://github.com/Nabsku/pi-prompt-workflows/commit/ddfe47fae23c571219cae84b1831521d2475f374))
* isolate best-of-n delegated workspaces ([6648790](https://github.com/Nabsku/pi-prompt-workflows/commit/6648790280b959090d0982cb19d56162b8c3c681))
* preserve best-of-n candidates on cancellation ([1eb8951](https://github.com/Nabsku/pi-prompt-workflows/commit/1eb89516851f588a60293abf8e78a162ec1501c6))
* preserve best-of-n slot identity ([2a1652e](https://github.com/Nabsku/pi-prompt-workflows/commit/2a1652eca3dc89cbdd444250b6f3dabefc6ea051))
* reject hidden best-of-n source state ([ad39f57](https://github.com/Nabsku/pi-prompt-workflows/commit/ad39f577394c583dd61b82633da39bde495bcae3))
* reject inherited context in best-of-n prompts ([90de586](https://github.com/Nabsku/pi-prompt-workflows/commit/90de58647083d97209b16edb2536ff37f82ccbe9))
* **subagent:** defer model resolution for model-less prompts ([08419ed](https://github.com/Nabsku/pi-prompt-workflows/commit/08419ed8f670c675d7a9a638b6e6341bccafbb60))
* **subagent:** defer model-less prompt rendering ([e97f6cb](https://github.com/Nabsku/pi-prompt-workflows/commit/e97f6cb0c659a54cfdc874749613c52c7bac9dd7))

## [0.18.2](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.18.1...v0.18.2) (2026-08-25)


### Bug Fixes

* sync upstream safety and progress safeguards ([d57fa87](https://github.com/Nabsku/pi-prompt-workflows/commit/d57fa87a9447a45dacc3ac6d2f7f26f98972b32c))

## [Unreleased]

### Bug Fixes

* honor delegated producer-owned progress rendering
* let model-less delegated prompts use the target agent's configured model
* refuse unsafe prompt invocation event paths before acknowledgement

## [0.18.1](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.18.0...v0.18.1) (2026-08-11)


### Bug Fixes

* harden prompt execution lifecycle ([40397a4](https://github.com/Nabsku/pi-prompt-workflows/commit/40397a4b2453c1366bdcc6dcf0eb96cfc01ec951))
* sync upstream prompt workflows ([b7ca73e](https://github.com/Nabsku/pi-prompt-workflows/commit/b7ca73ee63ff9550cc21db0a2b42bd5bc3d369e9))

## [0.18.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.17.0...v0.18.0) (2026-07-31)


### Features

* add typed prompt inputs ([f988eb3](https://github.com/Nabsku/pi-prompt-workflows/commit/f988eb3aab9690427bc49452b06b0e79dd9aa656))
* collect missing prompt inputs in TUI ([3f7586b](https://github.com/Nabsku/pi-prompt-workflows/commit/3f7586b99f5a090bf4de9cdd4bf925b0d2876e38))
* port low-risk upstream parity slices ([af1e837](https://github.com/Nabsku/pi-prompt-workflows/commit/af1e837917540e84d6bf53431991c8bf902e0717))
* render input and model conditionals together ([eac35ed](https://github.com/Nabsku/pi-prompt-workflows/commit/eac35ed8cc36a1d293f76c7a189a98945d847090))


### Bug Fixes

* close parity review gaps ([7c76a9c](https://github.com/Nabsku/pi-prompt-workflows/commit/7c76a9c13de5c0f8df8dee8005346c5a9f43cd11))
* close rebased codex findings ([710c8f5](https://github.com/Nabsku/pi-prompt-workflows/commit/710c8f59493eace5f2fc30e3fb2a61a429a0223d))
* close remaining codex input review gaps ([506ee8b](https://github.com/Nabsku/pi-prompt-workflows/commit/506ee8b812a547eccf428b5e99e42592f5f56f5f))
* close remaining interactive input review gaps ([792cfdb](https://github.com/Nabsku/pi-prompt-workflows/commit/792cfdb0d68690428ea2acb1c88776595eaff2fc))
* complete final input review findings ([8f7ec6c](https://github.com/Nabsku/pi-prompt-workflows/commit/8f7ec6c0e31b124f3b9dc945a0a0a2c3abc36849))
* harden input workflow and argument handling ([21c6bf0](https://github.com/Nabsku/pi-prompt-workflows/commit/21c6bf0c24e54d8ef54878eb01ed9439c2fec4bf))
* harden interactive prompt input boundaries ([fc606b6](https://github.com/Nabsku/pi-prompt-workflows/commit/fc606b6cfe9f6a49bbd53ef1a9c7417db6347b21))
* honor project trust and nested runtime discovery ([f5f3b96](https://github.com/Nabsku/pi-prompt-workflows/commit/f5f3b96c5138c9189f50271699b7a898d4feb4c6))
* honor q as prompt input cancellation ([3d7ae87](https://github.com/Nabsku/pi-prompt-workflows/commit/3d7ae8729016562bb6e1e663e7fadbd6592c2387))
* keep input value replacement non-recursive ([c9677b6](https://github.com/Nabsku/pi-prompt-workflows/commit/c9677b6316104a4a3dde54c2f7e458f4e5ac6684))
* limit interactive input repairs ([3e914bc](https://github.com/Nabsku/pi-prompt-workflows/commit/3e914bc9cac95c42ec453b9d27920bc9c66a0f10))
* make input cancellation side-effect free ([086335a](https://github.com/Nabsku/pi-prompt-workflows/commit/086335a09ea9bb8efdc7ed88d51e32552f4ce408))
* preserve input boundary semantics ([e2b29ec](https://github.com/Nabsku/pi-prompt-workflows/commit/e2b29ecb3435d7a9672c19a5f37bbad80eb1dd59))
* refine input form cancellation and diagnostics ([9da537c](https://github.com/Nabsku/pi-prompt-workflows/commit/9da537c66562e089fde16f6767c7716a1aa63f51))
* validate input references and dry-run args ([ed051b9](https://github.com/Nabsku/pi-prompt-workflows/commit/ed051b91ca2af101afb4a8b2c5ce5dd873771e21))
* validate prompt input references ([feba7fa](https://github.com/Nabsku/pi-prompt-workflows/commit/feba7fabcaa498cceeeefee30cda5d99ee078808))
* wire resolved inputs into prompt rendering ([e337ea6](https://github.com/Nabsku/pi-prompt-workflows/commit/e337ea611dbe792d73eb7110dd1e928ad7d2c1e1))

## [0.17.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.16.1...v0.17.0) (2026-07-30)


### Features

* add adaptive chain schema ([f91e23d](https://github.com/Nabsku/pi-prompt-workflows/commit/f91e23d2a1731b98d9ee34c2c03d61d3e16a855e))
* add bounded adaptive chain routing ([6026cca](https://github.com/Nabsku/pi-prompt-workflows/commit/6026cca4bcb84f2ddfe75e07b19561eca13c3800))
* add prompt budget estimates ([306b419](https://github.com/Nabsku/pi-prompt-workflows/commit/306b419244824c554f6d96751c7241b26451f68a))
* add verified worktree change snapshots ([7b3a039](https://github.com/Nabsku/pi-prompt-workflows/commit/7b3a0393513324e1a05eaff33299abf0e0d23501))
* enforce and report prompt budgets ([85a8ff2](https://github.com/Nabsku/pi-prompt-workflows/commit/85a8ff23910e4d6f9d40d7b3f29c4c25835df8a3))
* execute bounded adaptive chains ([7abf59e](https://github.com/Nabsku/pi-prompt-workflows/commit/7abf59e76ea00852b4005e6a47351487fd3d9f35))
* improve compare UX guidance ([be72803](https://github.com/Nabsku/pi-prompt-workflows/commit/be728031eb9f5a1b97c663f5bb51ceb5e6065c99))
* inspect adaptive chain execution ([8259fab](https://github.com/Nabsku/pi-prompt-workflows/commit/8259fab59132632d140efe0f5813b4ca8cfb20aa))
* normalize adaptive step outcomes ([7ab6661](https://github.com/Nabsku/pi-prompt-workflows/commit/7ab6661134fe9dfd0acb4283dbacada012fd5651))
* polish compare run history recovery ([96a8545](https://github.com/Nabsku/pi-prompt-workflows/commit/96a85452c96c3854c3fb9e8be9bf362c735fd094))
* tighten compare run recovery UX ([1c3f2a7](https://github.com/Nabsku/pi-prompt-workflows/commit/1c3f2a7e856d8525b9d27d45c55d8d2964debe08))
* validate and document adaptive chains ([5042066](https://github.com/Nabsku/pi-prompt-workflows/commit/5042066b9118c4c893ba311c13245a70caf5797e))


### Bug Fixes

* address compare recovery review feedback ([ad01b78](https://github.com/Nabsku/pi-prompt-workflows/commit/ad01b78e05efbcb8ab33ef27deeeac6bd5097f34))
* address compare review recovery commands ([47f9b96](https://github.com/Nabsku/pi-prompt-workflows/commit/47f9b96f01931baa403abf236d73296afd52bf06))
* align adaptive Git observation ([e24f291](https://github.com/Nabsku/pi-prompt-workflows/commit/e24f291975d8f87bce1ede6deb9e5d97382ad63d))
* align adaptive preflight state ([d669f56](https://github.com/Nabsku/pi-prompt-workflows/commit/d669f56db7227cff3bd6534ff9d54f6c9bce1e77))
* align adaptive runtime semantics ([92d4588](https://github.com/Nabsku/pi-prompt-workflows/commit/92d4588e755bd32ad5f9c97251f3b6e820f0dbec))
* align budget preflight with runtime ([0ab9f88](https://github.com/Nabsku/pi-prompt-workflows/commit/0ab9f883c47046293704b2826d6a86dfe2531587))
* align budget validation edge cases ([4128b74](https://github.com/Nabsku/pi-prompt-workflows/commit/4128b74f0b04a9b3d78483e34213cf4200c1a818))
* bound adaptive snapshot analysis ([ee86520](https://github.com/Nabsku/pi-prompt-workflows/commit/ee865207ba0247d0f21291aac9edc146b750cedc))
* close adaptive execution gaps ([146b46a](https://github.com/Nabsku/pi-prompt-workflows/commit/146b46a8ad8b0a9c6ba36a8d36bcdf414b21c7f6))
* close adaptive lifecycle edge cases ([15f4840](https://github.com/Nabsku/pi-prompt-workflows/commit/15f4840409b227a1a6eed30cd274dbe3a89adb97))
* close adaptive review gaps ([187662c](https://github.com/Nabsku/pi-prompt-workflows/commit/187662c96f0c098aebb2495b74d7a9e2934d3519))
* close adaptive state edge cases ([f5e8e32](https://github.com/Nabsku/pi-prompt-workflows/commit/f5e8e3258fc669bd2c7bdb5410c32472437df6d6))
* close compare UX blocker gaps ([5103f5e](https://github.com/Nabsku/pi-prompt-workflows/commit/5103f5e054f0d7da98987fa29c8cb39d5f062195))
* close follow-up compare review gaps ([95ecf5c](https://github.com/Nabsku/pi-prompt-workflows/commit/95ecf5c9c110fc8d76995e960eaec4f5dff3bd04))
* close remaining budget validation gaps ([949699f](https://github.com/Nabsku/pi-prompt-workflows/commit/949699fe9a0911bc92dce981a191d27c75d47d0b))
* complete adaptive chain inspection ([6c23125](https://github.com/Nabsku/pi-prompt-workflows/commit/6c231251a55013f2e8693bda0d6355c369323b9a))
* complete adaptive snapshot identity ([477a1c0](https://github.com/Nabsku/pi-prompt-workflows/commit/477a1c0c16e605969c1f5e6c3690bc5c71d638dc))
* complete adaptive submodule evidence ([c7ba3dc](https://github.com/Nabsku/pi-prompt-workflows/commit/c7ba3dc327a4ac94d6994191720b8406ce29069a))
* complete static budget preflight ([cbd4549](https://github.com/Nabsku/pi-prompt-workflows/commit/cbd45495c41faebeed12711d6fde4449a2ebd67c))
* defer conditional budget validation ([2b6578b](https://github.com/Nabsku/pi-prompt-workflows/commit/2b6578be33770fb05989baa3b220556a6cc4fcdb))
* enforce budgets on dispatched prompts ([06fcec4](https://github.com/Nabsku/pi-prompt-workflows/commit/06fcec4be0a0084be1ae31c44db31d28b94d89ad))
* harden adaptive path snapshots ([06d4c24](https://github.com/Nabsku/pi-prompt-workflows/commit/06d4c24465e10ffa06d7f0d9dfcc2668cc8b1502))
* isolate adaptive snapshot probes ([1941761](https://github.com/Nabsku/pi-prompt-workflows/commit/194176148b3cc7643e7b667adaf2c6d7f872dfb1))
* keep adaptive validation read-only ([1aeee37](https://github.com/Nabsku/pi-prompt-workflows/commit/1aeee37292bfc351dd360d62cb5f700f7858db4b))
* make adaptive snapshots semantically stable ([abba442](https://github.com/Nabsku/pi-prompt-workflows/commit/abba4425d57f5e7598cb0be3e005e4d5adbca5fe))
* package Git environment helper ([3a2c17b](https://github.com/Nabsku/pi-prompt-workflows/commit/3a2c17bfc4284175b91f1d31051cf7f8bc2870cb))
* parse quoted runtime flag values ([012d1a8](https://github.com/Nabsku/pi-prompt-workflows/commit/012d1a8f03564856f994bf12a12f5713c7ac37c8))
* preserve adaptive execution evidence ([605759a](https://github.com/Nabsku/pi-prompt-workflows/commit/605759a732a7beea31dcff643703ae655d0c550e))
* preserve adaptive index semantics ([a7f2266](https://github.com/Nabsku/pi-prompt-workflows/commit/a7f226621c2eb4ffd7dd31166286ddd237256563))
* preserve adaptive route guards ([e233543](https://github.com/Nabsku/pi-prompt-workflows/commit/e233543a8a3849c9079a001a2a5d0a42f41fa8d4))
* preserve adaptive routing semantics ([f49c5d9](https://github.com/Nabsku/pi-prompt-workflows/commit/f49c5d9d3ff4ed8cdb697a44e32e9e75c47a3330))
* preserve compare history cwd in recovery UI ([7f8c35f](https://github.com/Nabsku/pi-prompt-workflows/commit/7f8c35f4c39819006561f05575a4da8336ad4e5a))
* preserve Git output limit errors ([8a0e1fb](https://github.com/Nabsku/pi-prompt-workflows/commit/8a0e1fb396ab33ec226e7eb85c4de7ea8da262c8))
* report adaptive observations honestly ([ce69991](https://github.com/Nabsku/pi-prompt-workflows/commit/ce69991b9509d462fe68b8581382221f7154af7c))
* retain adaptive snapshot settings ([8501505](https://github.com/Nabsku/pi-prompt-workflows/commit/850150578b53e9e584a2dda523c8e4e80b17acc5))
* stabilize adaptive snapshots and cleanup ([e7b243f](https://github.com/Nabsku/pi-prompt-workflows/commit/e7b243f98bdff2f29abccb62e6b98a967d372cc7))
* summarize rendered static budgets ([84643f7](https://github.com/Nabsku/pi-prompt-workflows/commit/84643f7dd10c3ca4edefb1b66e884efe7e490f22))
* validate budgets against pinned models ([6138976](https://github.com/Nabsku/pi-prompt-workflows/commit/6138976f123e97923d2dd0d8209a607fcebb363a))

## [0.16.1](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.16.0...v0.16.1) (2026-07-06)


### Bug Fixes

* align workflows extension with upstream v0.10.0 ([22e7ca3](https://github.com/Nabsku/pi-prompt-workflows/commit/22e7ca3ad547aff254dec479c69ee89528a98d21))

## [0.16.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.15.0...v0.16.0) (2026-06-23)


### Features

* add compare dry-run and inspection UI ([670af6c](https://github.com/Nabsku/pi-prompt-workflows/commit/670af6c036e749ba5d9ff2310824a5ab1ca8ef54))
* add compare operability foundation ([f430fc1](https://github.com/Nabsku/pi-prompt-workflows/commit/f430fc1409a019a7b63ecd1ce1bc8737cbc6169a))
* add compare preflight and preset discovery ([8934fea](https://github.com/Nabsku/pi-prompt-workflows/commit/8934feaf1276dd6340ad96e5b3dfd6439148ab42))
* add compare run history command ([3515182](https://github.com/Nabsku/pi-prompt-workflows/commit/351518273d89192200b4826c7ac86711f872249f))


### Bug Fixes

* align compare dry-run preflight parity ([9180dff](https://github.com/Nabsku/pi-prompt-workflows/commit/9180dff4931561b6ffa6213f7b8732cf610d41cd))
* align compare preflight with runtime ([ef18d66](https://github.com/Nabsku/pi-prompt-workflows/commit/ef18d6602b793f4051972e8806e53ad35d3f5286))
* harden compare preset and run lookups ([7fd204e](https://github.com/Nabsku/pi-prompt-workflows/commit/7fd204eae2aa2952c4d38d713d0ae57fc00c5377))

## [0.15.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.14.0...v0.15.0) (2026-06-22)


### Features

* add best-of-n commit ask mode ([4bed638](https://github.com/Nabsku/pi-prompt-workflows/commit/4bed638ea9acc23b69d6c21bae8fe53b91362840))
* add best-of-n run reports ([0059555](https://github.com/Nabsku/pi-prompt-workflows/commit/0059555afb8a95cde0b688a4ac6779800b48259c))


### Bug Fixes

* close commit approval review gaps ([bf41003](https://github.com/Nabsku/pi-prompt-workflows/commit/bf410030ac62c82f711357d00d221cb5e56f08bf))
* cover dirty approval edge cases ([dc42b42](https://github.com/Nabsku/pi-prompt-workflows/commit/dc42b42e31238ae06b0a14e8dae4d8c120b86360))
* detect dirty approval changes precisely ([fe3c9fb](https://github.com/Nabsku/pi-prompt-workflows/commit/fe3c9fb6fbeb3131c39b143e65b0de1ed46090a9))
* handle approval review edge cases ([66b68c2](https://github.com/Nabsku/pi-prompt-workflows/commit/66b68c2cb05b822050e320d4f233032e3e8dcb7f))
* harden best-of-n commit approval ([670d88a](https://github.com/Nabsku/pi-prompt-workflows/commit/670d88a80170ebcba220f7e92b857dfed034c692))
* harden best-of-n commit ask handoff ([a667078](https://github.com/Nabsku/pi-prompt-workflows/commit/a6670789ac4351e1b20091b00c0b45f8a13d7df5))
* harden best-of-n report artifacts ([0f7df3d](https://github.com/Nabsku/pi-prompt-workflows/commit/0f7df3d22d44cffd6037fca83f20cbf3ac714105))
* preserve best-of-n lineup task metadata ([0d1159a](https://github.com/Nabsku/pi-prompt-workflows/commit/0d1159a41996ab4dfccf57bda1f042ac7d8e69ef))
* preserve commit ask git status columns ([145ed0e](https://github.com/Nabsku/pi-prompt-workflows/commit/145ed0efbe55ecb3eb3bb0c5be26bba9b68d1f27))
* record actual best-of-n delegated tasks ([5c175d9](https://github.com/Nabsku/pi-prompt-workflows/commit/5c175d9b21b028ee80b4eac9d8731d447aa8c20f))
* record effective best-of-n tasks ([e9d14d1](https://github.com/Nabsku/pi-prompt-workflows/commit/e9d14d1dda64be91468aa5d9071fbe069bcf9328))
* use raw git diff capture for approval ([be1d06b](https://github.com/Nabsku/pi-prompt-workflows/commit/be1d06b4436bffbdcdfe1bca4a49abdbebabde1a))

## [0.14.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.13.1...v0.14.0) (2026-06-22)


### Features

* add best-of-n preset resolution ([e0f45e6](https://github.com/Nabsku/pi-prompt-workflows/commit/e0f45e64490e6874e6693e7b6450954d7f9dde64))


### Bug Fixes

* address best-of-n preset review comments ([0dfdf80](https://github.com/Nabsku/pi-prompt-workflows/commit/0dfdf8065c0a241f0786f7271800b1c877b117cc))
* close preset review edge cases ([df85bf3](https://github.com/Nabsku/pi-prompt-workflows/commit/df85bf3d86c2f43bcbec8d9fdb150e2fde37e61f))
* close preset validation review gaps ([1822061](https://github.com/Nabsku/pi-prompt-workflows/commit/1822061ae90ee9b5ee2d7ea222ce9cabc9698e79))
* harden best-of-n preset overrides ([caa0981](https://github.com/Nabsku/pi-prompt-workflows/commit/caa0981936d5e264f5e2dd334d9f0e1abe59aa59))
* harden project preset resolution ([04cddc9](https://github.com/Nabsku/pi-prompt-workflows/commit/04cddc919256b0c40b28a51b67c185a592f899fb))
* prevent invalid project presets from falling through ([8b0f589](https://github.com/Nabsku/pi-prompt-workflows/commit/8b0f5899ca5ebd1350218cd0d87d24af891a9656))
* validate presets from prompt cwd ([ce97729](https://github.com/Nabsku/pi-prompt-workflows/commit/ce9772947bf31abbc1fc4481bdc13bf51385da62))

## [0.13.1](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.13.0...v0.13.1) (2026-06-21)


### Bug Fixes

* harden prompt-library parity coverage ([1666691](https://github.com/Nabsku/pi-prompt-workflows/commit/16666916eff1757cefa4b743cdbb18ea704b95a5))

## [0.13.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.12.0...v0.13.0) (2026-06-21)

### Prompt library

* Added `.pi/prompt-library` and `~/.pi/agent/prompt-library` roots for reusable prompt commands, chain steps, and include fragments ([b5e235b](https://github.com/Nabsku/pi-prompt-workflows/commit/b5e235b099df3a4089b196a3e482c64e545f5bbb), [4eba6b3](https://github.com/Nabsku/pi-prompt-workflows/commit/4eba6b3c98b83d50ab167e66eb26c782ade00d99)).
* Prompt-library commands now support validation, source summaries, dry-run/TUI labels, and includes from library-local fragments ([7dec4c8](https://github.com/Nabsku/pi-prompt-workflows/commit/7dec4c8bc2f774fa6451c842f9ee12cc875de648), [5468b16](https://github.com/Nabsku/pi-prompt-workflows/commit/5468b16e19ac1e556980f9a5416fc574be055aeb), [ceda208](https://github.com/Nabsku/pi-prompt-workflows/commit/ceda208e9f027d7a45c600bf2bcfb36d4552f55e)).
* Added `hidden: true` for internal prompt-library commands: hidden commands stay out of slash-command discovery and pickers, but remain addressable by exact dry-run/print lookup and chain references ([413ef55](https://github.com/Nabsku/pi-prompt-workflows/commit/413ef55ac8c3bafe61c8b1a3d560eb644e7e7d15)).

### Hardening and compatibility

* Tightened project prompt-library trust boundaries, including chain preflight approval and safer handling of project library includes ([c1198cf](https://github.com/Nabsku/pi-prompt-workflows/commit/c1198cf918045db38d2d7c8f767e1be82843f634), [40c4458](https://github.com/Nabsku/pi-prompt-workflows/commit/40c44587ff8a94e2f6d6d94f13a9c2894503d35b)).
* Hardened prompt-library loading around symlinks, dot-prefixed entries, invalid metadata, include-only fragments, and stale hidden command handlers ([94c8bdd](https://github.com/Nabsku/pi-prompt-workflows/commit/94c8bddcba1d16502676d34f47fccbeb3235fd05), [b62cbec](https://github.com/Nabsku/pi-prompt-workflows/commit/b62cbecbeaf25ecef66abf14c6e71bca03c40c3c), [ace7651](https://github.com/Nabsku/pi-prompt-workflows/commit/ace76519fcea80a20b217ce82e62a201ad0afa06)).
* Plain prompt-library fragments now stay quiet unless included, while valid thinking-only and model-conditional library commands still load normally ([c353e1e](https://github.com/Nabsku/pi-prompt-workflows/commit/c353e1e0d10377e94bae763084efd1f9ac398260), [f2e8850](https://github.com/Nabsku/pi-prompt-workflows/commit/f2e8850ea2c5be080d7c73764303f5fabdcd1c44), [8808b05](https://github.com/Nabsku/pi-prompt-workflows/commit/8808b05eeafd226adfb5a57a07c195d0550fe4e8), [dea05fc](https://github.com/Nabsku/pi-prompt-workflows/commit/dea05fc9b27755f9407976e4028f77704e27e044)).
* Validation source summaries now count broken, skipped, duplicate, empty-model, invalid-marker, and shadowed library commands consistently instead of misreporting them as fragments or dropping them ([354bea9](https://github.com/Nabsku/pi-prompt-workflows/commit/354bea956a13e0845167246f4ba68778db5ce6b8), [126ab9b](https://github.com/Nabsku/pi-prompt-workflows/commit/126ab9bbe2149f1c6c78967ded308f56f933a6e7), [fd028ca](https://github.com/Nabsku/pi-prompt-workflows/commit/fd028ca1ad78f329ef1d9325158d66a2541701e4), [0fc6877](https://github.com/Nabsku/pi-prompt-workflows/commit/0fc6877dca2b16385d7a95e6d01a7a3f94d2ce07), [e8a91d1](https://github.com/Nabsku/pi-prompt-workflows/commit/e8a91d14be0430894cdc3716f28754ad561edd68), [73c91c1](https://github.com/Nabsku/pi-prompt-workflows/commit/73c91c1b2d41792528dc32c5e9798b7bb213c09e)).

## [0.12.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.11.2...v0.12.0) (2026-06-20)


### Features

* add includes pane to dry-run TUI ([50624a4](https://github.com/Nabsku/pi-prompt-workflows/commit/50624a46a5722d2ca74ebcb0423e5e99f75dbad1))
* attach include graphs to dry runs ([a1d7eba](https://github.com/Nabsku/pi-prompt-workflows/commit/a1d7eba676158faed0c4e9cf889e5525cf5e5923))
* attach include graphs to validation ([d694724](https://github.com/Nabsku/pi-prompt-workflows/commit/d69472452a6af1b7f94f75df3002b65d5bdc62c8))
* collect prompt include graphs ([be7c726](https://github.com/Nabsku/pi-prompt-workflows/commit/be7c726fb17a43524068ef8da819306304e79091))
* collect prompt source records ([0d0df7a](https://github.com/Nabsku/pi-prompt-workflows/commit/0d0df7a38a460fb1d890596e8f334a9be5772892))
* expose prompt include parsing helpers ([3e784a6](https://github.com/Nabsku/pi-prompt-workflows/commit/3e784a672304100e70ae3a6603a05be6c2744e5e))
* report prompt include graphs ([5332c8e](https://github.com/Nabsku/pi-prompt-workflows/commit/5332c8e8c49925aec20ebe2ba913e6b6a13f814f))


### Bug Fixes

* avoid duplicate include graph diagnostics ([adb6c97](https://github.com/Nabsku/pi-prompt-workflows/commit/adb6c971fa3e1faea902aead4493fd47cf4121a6))
* preserve skipped include graphs for overrides ([2b0e69f](https://github.com/Nabsku/pi-prompt-workflows/commit/2b0e69f3f158c8e5e8ef3bae45053cdd267a19e7))

## [0.11.2](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.11.1...v0.11.2) (2026-06-19)


### Bug Fixes

* publish after release-please releases ([7949c6c](https://github.com/Nabsku/pi-prompt-workflows/commit/7949c6cb313f62f2dc8cc5ab707b90413e3095ac))

## [0.11.1](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.11.0...v0.11.1) (2026-06-19)


### Bug Fixes

* allow skills in delegated prompts ([d7c0e0e](https://github.com/Nabsku/pi-prompt-workflows/commit/d7c0e0e1c8a8e2b728aa2fa20c9e5037002b761e))

## [0.11.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.10.0...v0.11.0) (2026-06-19)


### Features

* add prompt dry-run commands ([80548b3](https://github.com/Nabsku/pi-prompt-workflows/commit/80548b34471aa1ae98436c61f5a202d9734f831c))
* add prompt dry-run core ([3edc51a](https://github.com/Nabsku/pi-prompt-workflows/commit/3edc51aace8eccac557bec4d0e83c859a6baa4a8))
* add prompt dry-run TUI ([d99e7da](https://github.com/Nabsku/pi-prompt-workflows/commit/d99e7da3e62f70ecda9fcaebcf5ce1b84e306a73))
* add prompt validation command ([a82a029](https://github.com/Nabsku/pi-prompt-workflows/commit/a82a029e56e51a29295f0b98379acaa643721a24))
* render prompt dry-run output ([8c0cdb5](https://github.com/Nabsku/pi-prompt-workflows/commit/8c0cdb5bcc622ca38f215a146a59f9e3dca55e0a))


### Bug Fixes

* address dry-run TUI review feedback ([af3b6b0](https://github.com/Nabsku/pi-prompt-workflows/commit/af3b6b0f30ad779b79f5548aea51ac22c3fde4be))
* align prompt dry-run loop metadata ([bd9f9ea](https://github.com/Nabsku/pi-prompt-workflows/commit/bd9f9eae3841a515b848a7b73c83b86711b6b456))
* keep prompt dry-run out of history ([86e31b8](https://github.com/Nabsku/pi-prompt-workflows/commit/86e31b8a895a8579ec0a8d40b800c6dd6faa827b))
* polish TUI rendering edge cases ([d5c5c77](https://github.com/Nabsku/pi-prompt-workflows/commit/d5c5c776d0ad34c75e67f147f35cb72a39e14b1e))
* support Kitty inspector controls ([f09904c](https://github.com/Nabsku/pi-prompt-workflows/commit/f09904c5359e75e2cbf4a784bdcddc487d6ad8c7))
* support Kitty picker input ([2679c62](https://github.com/Nabsku/pi-prompt-workflows/commit/2679c6237d85d455a34ff87a76eb463843010b1c))

## [Unreleased]

### Added
- Added `/print-prompt` and `/dry-run-prompt` to preview rendered prompt templates without execution.
- Added a Pi-native dry-run TUI: no-name dry-run commands open a searchable template picker in Pi TUI mode, while named templates open a read-only inspector for prompt body, metadata, skills, includes, warnings, and the raw report.
- Added a static, permanent `Includes` pane to the dry-run TUI inspector. It shows the include graph captured during dry-run rendering, or `No includes.` for prompts without include metadata or inline include directives.

### Changed
- Added `/validate-prompts` to validate prompt templates, includes, chain declarations, and skill references before runtime, including include graph reporting for prompt dependencies and include failures.
- Updated development-only Pi packages from the deprecated `@mariozechner/*` namespace to `@earendil-works/*` `0.79.7`, and bumped `tsx` to `^4.22.4`.
- Added Dependabot version updates for npm development dependencies and GitHub Actions.
- Added Release Please release automation and npm trusted publishing workflow.

### Fixed
- Delegated prompt templates can now combine `subagent:`/runtime `--subagent` with `skill` or `skills`; resolved skill content is prepended to delegated task text instead of rejecting the template.
- Kept dry-run output out of LLM/session history by writing plain previews to stdout instead of custom session messages.
- Aligned dry-run delegation metadata with runtime behavior for default agents, missing delegated `cwd`, loop prefixes, and parallel delegated task preambles.

## [0.10.0] - 2026-06-18

### Added
- Published under the separate package name `pi-prompt-workflows` for the enhanced fork line.
- Added plural `skills` frontmatter for prompt templates, including ordered multi-skill injection and constrained suffix-wildcard selectors such as `golang-*`.

### Changed
- Skill context now renders as one combined context message while preserving backward compatibility for singular `skill` prompts.

### Fixed
- Fixed delegated prompt execution discovery for current `pi-subagents` npm package layouts, including `src/agents/agents.ts`, so `pi install npm:pi-subagents` works without setting `PI_SUBAGENT_RUNTIME_ROOT` manually.

## [0.9.3] - 2026-04-28

### Fixed
- Delegated prompt templates now discover `pi-subagents` installs from project-local Pi npm paths and sibling npm package paths instead of the legacy `subagent` extension path, fixing #1. Thanks @hschne for the report.

## [0.9.2] - 2026-04-28

### Fixed
- Prompt templates now accept provider-qualified model IDs that contain additional slashes, such as `openrouter/openai/gpt-5.4`, across prompt loading, model selection, compare lineups, and `<if-model>` conditionals.

## [0.9.1] - 2026-04-26

### Fixed
- `boomerang: true` prompt collapses now signal rewind to keep current files automatically, avoiding the restore-options prompt during collapse.

## [0.9.0] - 2026-04-25

### Added
- Added `boomerang: true` prompt frontmatter so non-chain templates, including looped templates, can run through prompt-template-model and then collapse their execution context back to the pre-run branch.

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed
- Added `typebox` as a runtime dependency for packaged installs.

## [0.8.2] - 2026-04-21

### Added
- Added the packaged `prompt-template-authoring` skill for creating and maintaining prompt templates with this extension.

### Changed
- Tightened the shipped skill guide so it stays short, repo-specific, and aligned with the actual prompt-template runtime.

### Fixed
- Corrected the shipped skill examples for model fallback vs rotation, argument substitution, deterministic handoff behavior, chain context wording, runtime flag syntax, and prompt discovery rules.
- Removed the emoji from the skill-loaded renderer so the UI copy matches the extension's plain-text style.

## [0.8.1] - 2026-04-21

### Added
- Added agent skill `prompt-template-authoring` for writing, managing, and running custom prompt templates. Registered in `package.json` under `pi.skills`.

## [0.8.0] - 2026-04-21

### Added
- Added first-class deterministic prompt-template execution for single prompt templates via `deterministic:` or shorthand `run` / `script` frontmatter. Templates can run one direct command or script before any optional LLM turn.
- Added configurable deterministic-step handoff policies: `always`, `never`, `on-success`, and `on-failure`.
- Added deterministic result cards that always show the executed command or script, resolved `cwd`, exit code, duration, and stdout/stderr previews.
- Added deterministic-step `env` support plus `nonInteractive` control for deploy/release-style scripts that need explicit environment variables or want to disable the default non-interactive guardrail env bundle.
- Added a visible deterministic completion message for `handoff: never`, so no-handoff runs still end with an explicit completion marker after the result card.

### Changed
- When a deterministic prompt hands off to the model, the extension now prepends a generated `[Deterministic step]` block with structured execution metadata and truncated stdout/stderr previews before the prompt body.
- Deterministic stdout/stderr payloads are now capped before they are stored in message details, while preserving total line/character counts and truncation metadata for both the card UI and the LLM handoff block.

### Fixed
- Added regression coverage for deterministic loader parsing, relative script resolution, handoff gating, and the no-handoff fast path.
- Deterministic timeouts now escalate from `SIGTERM` to `SIGKILL` if the child process does not exit within the post-timeout grace window.

## [0.7.3] - 2026-04-14

### Fixed
- `/chain-prompts` and chain templates now resolve plain prompt files without extension-specific frontmatter, so standard prompts like `double-check -> deslop` work in chain execution.
- Added regression coverage for plain-prompt chain resolution while keeping ordinary prompt-template command registration unchanged.

## [0.7.2] - 2026-04-04

### Changed
- Added a `promptSnippet` for `run-prompt` so Pi 0.59+ includes it in the default tool prompt section and keeps prompt-template execution discoverable in agent turns.

## [0.7.1] - 2026-04-03

### Changed
- Bumped `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-tui` to `^0.65.0` and updated the extension for the pi `0.65.0` session/runtime breaking changes (`session_start` migration and `getApiKeyAndHeaders()` auth lookup).

### Fixed
- Added regression coverage for the shipped `best-of-n` example and re-verified the installed prompt still matches the shipped example used for manual installs.

## [0.7.0] - 2026-04-01

### Added
- Added a first-class `bestOfN:` prompt-template authoring surface for compare workflows, with configurable `workers`, `reviewers`, optional `finalApplier`, and nested `bestOfN.worktree` support.
- Added configurable compare runtime overrides via `--workers`, `--reviewers`, `--workers-append`, `--reviewers-append`, and `--final-applier`.
- Added `count: N` compare-slot shorthand so one worker or reviewer slot can fan out into repeated identical runs without manual duplication.
- Added a shipped `/best-of-n` example prompt that demonstrates mixed worker counts, mixed reviewer counts, thinking-level model suffixes, `taskSuffix`, and final real-branch application.

### Changed
- Compare prompts now run as worker fan-out, reviewer fan-in, then an optional final apply step that edits the real branch instead of stopping at recommendation prose.
- Reviewer defaults now stay findings-only, while `finalApplier` handles winner-picking or synthesis plus best-effort verification on the current branch.
- Legacy top-level compare frontmatter in templates (`workers`, `reviewers`, `finalApplier`, top-level compare `worktree`) is now rejected in favor of `bestOfN:`.
- Delegated parallel live rendering now shows richer per-task output, including task index, model, recent tools, and bounded rolling output lines.
- README and bundled examples were refreshed to match the shipped compare/runtime surface, including `bestOfN`, compare-wide vs slot-level `cwd`, and chain `parallel(...)` `cwd` rules under `worktree: true`.

### Fixed
- Compare execution now allows partial success by phase: worker and reviewer phases continue as long as at least one slot succeeds, and `finalApplier` can still fall back to worker-only evidence when every reviewer fails.
- Preserved successful worker `=== Worktree Changes ===` summaries when building reviewer and final-apply inputs, so downstream compare stages do not lose worktree evidence.
- Invalid `bestOfN` blocks and legacy compare templates no longer degrade into ordinary runnable prompts after diagnostics; they are skipped entirely.
- `finalApplier` validation now correctly rejects unsupported `cwd` and `count` fields in both frontmatter and runtime overrides.
- Corrected remaining docs/tooling drift, including the `run-prompt` unlimited-loop cap text and compare/chain `cwd` wording.

## [0.6.10] - 2026-03-30

### Added
- Added lineup-based compare frontmatter for prompt templates: `workers` and `reviewers` slot lists (`agent` or `subagent`, optional `model`, optional `task`, optional `taskSuffix`, optional `cwd`, optional `count`), plus optional `finalApplier` for one final apply step.
- Added a two-phase compare execution flow for lineup templates: parallel worker phase first, then reviewer phase fed by aggregated worker output.
- Added runtime lineup override flags for compare templates: `--workers`, `--reviewers`, `--workers-append`, `--reviewers-append`, and `--final-applier`.
- Added compare lineup `count: N` shorthand so one worker or reviewer slot can expand into repeated identical runs without manually duplicating entries.
- Added an example compare prompt template under `examples/`: `best-of-n`, intended for manual installation into `~/.pi/agent/prompts/`.
- Added compare-lineup `subagent` shorthand so prompt authors can use `subagent: true` for default worker/reviewer slots instead of spelling the internal `delegate` / `reviewer` agent names directly.

### Changed
- Prompt-template compare authoring now uses nested `bestOfN:` frontmatter; the loader lowers `bestOfN.workers`, `bestOfN.reviewers`, `bestOfN.finalApplier`, and `bestOfN.worktree` into the existing runtime compare fields and rejects legacy top-level compare fields in templates.
- Removed fixed three-worker compare assumptions from docs and prompt guidance; compare lineups are now caller-defined and duplicate slots are preserved.
- The shipped `best-of-n` example now shows mixed workers, mixed reviewers, and an optional final apply phase, while the runtime fallback still stays at one worker when `workers` is omitted.
- Reviewers now default to findings-only output, and the optional final phase now applies the real-branch patch instead of ending at recommendation prose.
- Parallel delegated task contract now supports per-task `cwd` passthrough end-to-end across the prompt-template bridge.
- README now explains same-model vs multi-model best-of-N configuration explicitly.

### Fixed
- Compare execution now uses partial-success-by-phase behavior: worker and reviewer phases continue as long as at least one slot succeeds, and `finalApplier` can fall back to worker-only synthesis if reviewer slots all fail.
- Compare lineup slots now support `taskSuffix` so shared worker/reviewer instructions can stay in the prompt body while slots add small per-model suffixes such as output-file paths.
- Documented the current compare worktree constraint explicitly: when `worktree: true` is enabled, all worker slots must resolve to the same `cwd`.

## [0.6.9] - 2026-03-28

### Added
- Added `worktree: true` frontmatter and `--worktree` runtime flag for chain templates with parallel steps. When enabled, each parallel subagent runs in its own git worktree to avoid file conflicts during concurrent execution. Requires a chain with at least one `parallel()` step.
- Added `parallel: N` frontmatter for delegated prompts. This expands one delegated prompt into `N` parallel `pi-subagents` tasks targeting the same agent, with automatic slot headers like `[Parallel subagent 2/3]` prepended to each task.

### Changed
- Bumped `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-tui` to `^0.64.0`.
- Delegated prompt execution now forwards `ctx.signal` into subagent runs so turn cancellation can stop in-flight delegated work for both single delegated prompts and delegated parallel chain steps.
- `worktree: true` now also works on delegated prompts that use `parallel: N`, not just chain templates with `parallel()` steps.

## [0.6.8] - 2026-03-28

### Added
- Delegated prompt results are now injected back into the parent conversation as a user message, triggering an agent turn so the parent agent can process and respond to the delegation outcome. Applies to single delegated runs, delegated loops, and delegated chain steps.

## [0.6.7] - 2026-03-28

### Changed
- Delegation progress widget now shows a unified tool stream where completed tools scroll chronologically with the active tool highlighted at the bottom, replacing the old design where the active tool flashed at the top and disappeared on completion.
- Delegation progress widget now renders the subagent's model name in the header (e.g., `delegate [fork] gpt-5.3-codex | 14 tools, 170k tok, 2m47s`).
- Delegation progress widget no longer caps tool history or output lines. The box grows to show the full execution trace.
- Delegation progress widget now refreshes every second during idle periods (model thinking) so the elapsed timer ticks smoothly instead of freezing between progress updates.
- Enriched the delegation bridge protocol to pass through full `recentOutputLines`, `recentTools` history, and `model` from pi-subagents progress data, replacing the old single-line `recentOutput` and missing tool/model fields.
- Removed `lastTool`/`lastToolArgs` tracking from live state (dead code after the unified tool stream redesign).

## [0.6.6] - 2026-03-28

### Added
- Added `--model=provider/model-id` runtime flag to override a template's model for a single invocation. Works with single execution, loops, and delegation.
- Added `--fork` runtime flag to enable `inheritContext` (forked context) at invocation time. Implies `--subagent` if not already set.
- Inline loop iterations now include a `[Loop 2/5]` prefix so the agent knows it's in a loop and which iteration it's on. Delegated (subagent) loops are unaffected.
- Added `loop: unlimited` (and `loop: true`) frontmatter for open-ended loops that run until convergence, user interrupt, or the 999-iteration safety cap.
- Added model rotation for loop iterations via `rotate: true` frontmatter. Cycles through comma-separated models and thinking levels each iteration instead of using fallback semantics.

### Fixed
- Pressing Escape during a loop or chain iteration now stops the loop. Previously, aborted inline turns were treated as "no changes" and the loop continued.
- Delegation errors during loop iterations no longer abort the entire loop. The error is reported and the loop continues to the next iteration (useful with model rotation where one model may fail but others succeed).
- Per-step bare `--loop` in chain declarations (e.g., `double-check --loop -> deslop`) now correctly runs unlimited iterations instead of running once.

### Changed
- Unlimited loops (`--loop` bare or `loop: unlimited`) no longer force convergence on. Convergence follows the `converge` field like bounded loops. Safety cap raised from 50 to 999.

## [0.6.5] - 2026-03-24

### Added
- Added delegated chain-step context summaries via `chainContext: summary` (chain frontmatter), `/chain-prompts ... --chain-context` (command-level), and per-step `--with-context` (single delegated chain steps).

## [0.6.4] - 2026-03-23

### Fixed
- Updated skill command resolution to use `sourceInfo.path` instead of the removed `path` field on `SlashCommandInfo`, fixing compatibility with pi-coding-agent 0.62.0 source provenance changes.

## [0.6.3] - 2026-03-21

### Added
- Chain step progress now shows in the status bar (e.g., `step 2/3: simplify`) and persists until the chain completes, instead of only appearing as a notification that scrolls away.
- Added `parallel(...)` chain step support for delegated prompt templates, including parser/frontmatter validation, delegated task fan-out, aggregated result rendering, and per-task progress display.

### Fixed
- Delegated subagent errors now show as clean notifications instead of extension crash messages with stack traces, matching how other validation errors (missing skill, missing template, etc.) are presented.
- When no subagent bridge is listening (extension not loaded, name collision with another extension), delegation now fails immediately with a diagnostic message instead of silently waiting 15 seconds before timing out.
- Timeout error message no longer dumps the full rendered prompt content; uses the agent name instead.
- Parallel delegated status now prefers aggregate `parallel X/Y running` updates over first-task tool labels, avoiding misleading `running <tool>` status lines during multi-task execution.

## [0.6.2] - 2026-03-20

### Added
- Added delegated-subprocess working directory controls via `cwd` frontmatter (for `subagent` prompts and chain-template defaults) plus runtime `--cwd=<path>` overrides.

### Fixed
- Rewrote README for clarity: fixed default subagent name (`delegate`, not `worker`), corrected provider priority to include `openai-codex`, merged broken frontmatter table into grouped sections with readable descriptions, cut redundant examples, and tightened prose throughout.

## [0.6.1] - 2026-03-20

### Added
- Added delegated prompt execution via direct extension event bus communication with `subagent` (`prompt-template:subagent:*` channels), including delegated custom-message persistence for loop summaries and context carry-forward.
- Added prompt frontmatter support for `subagent` and `inheritContext`, with `inheritContext: true` mapped to delegated fork context.
- Fork context preamble is handled by the subagent extension directly (via `DEFAULT_FORK_PREAMBLE` in `types.ts`), applying to all fork-context subagent runs universally.
- Added runtime delegation override flags: `--subagent`, `--subagent=<name>`, and `--subagent:<name>`.
- Added live progress widget above editor during delegated subagent runs showing elapsed time, tool count, tokens, current tool, and task preview — matching the native subagent tool card layout.
- Added styled completion card with task preview, tool call history, expandable output (Ctrl+O), and usage stats footer.

### Changed
- Updated provider priority for ambiguous bare model IDs to prefer `openai-codex` before `anthropic`, `github-copilot`, and `openrouter`.
- Updated loop convergence and fresh-summary analysis to account for delegated subagent message payloads.

### Fixed
- Delegated start-time hangs now fail fast with explicit timeout errors when a subagent run never emits a start signal.
- Delegated runs no longer treat arbitrary escape-sequence-bearing terminal input as an Esc cancellation signal; only literal Esc cancels.
- Chain and loop restore paths now use live runtime model/thinking state during cleanup, preventing skipped restore on mid-step failures.

## [0.6.0] - 2026-03-19

### Changed

- Clarified the README chain examples so the optional ` -- ` shared-args separator is clearly distinct from loop flags like `--loop`, `--fresh`, and `--no-converge`.
- Clarified in the README that chain frontmatter declarations support per-step `--loop N` inside the `chain:` value.
- Argument substitution now accepts `@$` as an alias for `$@` for compatibility with commonly-typed placeholder variants.
- Skill injection now uses a next-turn context message from `before_agent_start` instead of mutating the turn system prompt.
- Non-chain templates can now omit `model` and inherit the current session model, so inline `<if-model ...>` rendering and skill injection still work without explicit model frontmatter.
- Chain steps without `model` now inherit a fixed chain-start model snapshot, so model-less chain steps behave as if that model were declared in frontmatter while remaining deterministic across step switches.

### Fixed

- Chain step execution now avoids implicit previous-step model bleed for model-less templates by resolving them against the chain-start model snapshot instead of whichever model was active after the prior step.
- Model-less prompt loading now skips plain templates that do not use extension features, preventing command collisions with other extension commands like `/review` and `/handover`.
- Model-less prompt loading now also ignores no-op/invalid-only extension metadata (for example `restore`-only or invalid loop flags), so ineffective frontmatter does not unnecessarily claim command names.
- Model-less prompt loading now recognizes invalid conditional closers like `</else>` as extension-relevant markup, so those templates stay in this extension path and surface proper conditional-parse warnings instead of silently bypassing extension handling.
- Model-less prompt execution now tracks runtime model changes (`model_select` + internal switches/restores) and uses that tracked model instead of potentially stale command-context snapshots.
- Prompt commands now fail fast when a configured `skill` file is missing or unreadable, instead of silently sending the prompt without skill context.
- Skill resolution now returns a typed success/error outcome that callers handle explicitly, rather than emitting notifications from inside the resolver and returning sentinel `null` values.
- Session start/switch now clear any queued skill context message so stale pending skill payloads cannot leak across session boundaries.
- Session start/switch now also clear pending single-command restore state (`previousModel`/`previousThinking`) so restore writes cannot leak into a different session.
- Skill frontmatter resolution now checks registered skill commands first (`pi.getCommands()` skill entries), accepts both `<name>` and `skill:<name>` values, searches additional standard pi skill locations (`.agents/skills` in project ancestors and `~/.agents/skills`), supports direct `<skill>.md` files alongside `SKILL.md` directories, and rejects traversal-like skill names for path fallback.
- `extractLoopCount()` now strips repeated unquoted `--loop` tokens once looping is active, preventing stray loop flags from leaking into prompt arguments.
- Chain frontmatter step parsing now strips repeated per-step `--loop` tokens once a valid per-step loop is resolved, and keeps the first valid value (including mixed invalid/valid numeric sequences like `--loop 1000 --loop 2`).
- Loop-mode restore now tracks runtime model/thinking state per iteration instead of relying on command-context model snapshots, so model restoration remains correct even when command context values are stale.
- Chain execution now restores model/thinking state in a `finally` path, so restore still runs after unexpected runtime errors during a chain step and chain cleanup state is still reset even when restore itself fails.
- Loop and chain executions no longer report `Loop finished`/`Loop converged` when runtime errors abort execution mid-loop.
- Loop and chain error propagation now preserves thrown falsy values (for example `throw 0`) instead of treating them as success, preventing swallowed errors and false completion notifications.

## [0.5.0] - 2026-03-17

### Added

- Loop execution via `--loop` flag: `--loop N`, `--loop=N` to run a prompt N times (1-999), or bare `--loop` for unlimited until convergence with a 50-iteration safety cap. Bare `--loop` always forces convergence on.
- Frontmatter loop controls: templates can now set `loop: N` (1-999) and `converge: false` defaults; CLI `--loop` overrides frontmatter `loop`, and `--no-converge` disables convergence for bounded loops.
- Convergence detection: loops stop early when an iteration makes no file changes (`write`/`edit`). Enabled by default; `--no-converge` opts out.
- Fresh context mode: `--fresh` flag or `fresh: true` frontmatter collapses conversation between loop iterations, keeping only accumulated summaries. Saves tokens on long loops.
- Loop iteration context injected into the system prompt so the agent builds on previous work across iterations.
- Loop progress indicator in the TUI status bar.
- `run-prompt` agent tool: the agent can run prompt templates, chains, and loops on its own. Opt-in via `/prompt-tool on [guidance]`. Config persists in `~/.pi/agent/prompt-template-model.json`.
- Chain templates: new `chain` frontmatter field to declare reusable template pipelines (`chain: double-check --loop 2 -> deslop --loop 2`). Per-step `--loop N` loops each step independently. No `model` required — each step uses its own. Supports `loop`, `fresh`, `converge`, `restore` for overall execution control. Chain nesting is rejected at runtime.

### Fixed

- `readSkillContent` no longer swallows read errors. The caller now sees the actual error message (e.g., permission denied) instead of a generic "Failed to read skill" notification.
- `restoreSessionState` no longer clears `pendingSkill` as a side effect unrelated to model/thinking restoration.
- Error diagnostics now consistently use `String(error)` instead of hardcoded fallback strings.

## [0.4.0] - 2026-03-13

### Added

- Inline `<if-model is="...">...</if-model>` blocks with optional `<else>` branches inside prompt bodies.
- Provider wildcard matching in conditionals with syntax like `anthropic/*`.
- Conditional rendering now happens after model fallback resolution for both single prompt commands and `/chain-prompts`.
- Prompt argument substitution now mirrors pi core more closely, including `${@:N}` and `${@:N:L}` slice syntax. See README for full placeholder reference.

### Fixed

- Model fallback now preserves the currently active model whenever it matches any listed fallback candidate, including ambiguous bare model IDs that would otherwise resolve through provider preference, instead of switching to an earlier candidate unnecessarily.
- Prompt templates that collide with reserved slash commands, including built-ins like `/model` and the extension’s own `/chain-prompts`, are now skipped with a warning instead of being silently shadowed.
- Prompt discovery is now deterministic in a locale-independent way, and duplicate model-enabled prompt names within the same source layer are skipped with a warning instead of silently depending on traversal order.
- Invalid `model` frontmatter declarations are now rejected during prompt loading with diagnostics instead of failing later at execution time.
- Literal tags like `<elsewhere>` and `</if-modeling>` no longer get misparsed as malformed conditional directives.
- Non-interactive notifications now go to stderr so print-mode stdout stays clean.
- Bare model IDs with multiple providers can now still resolve through OAuth-backed auth checks even when fast availability checks alone are inconclusive.
- Optional string frontmatter fields are now trimmed so quoted values like `thinking: " high "` and `skill: " tmux "` behave as expected.
- Existing prompt commands now refresh prompt files before execution, so edits made during a session take effect on the next run instead of waiting for a new session.
- Skill-loaded custom messages now fail safe if their details payload is missing instead of crashing the renderer.
- Frontmatter `model` specs and inline conditional `is` specs now reject internal whitespace like `anthropic /model` or `anthropic /*` instead of silently registering values that can never match.
- Recursive prompt discovery now detects already-visited directories and skips symlink loops instead of risking infinite recursion or duplicate traversal.
- Bare model IDs now honor provider priority across all auth-capable candidates, including OAuth-backed providers, instead of incorrectly favoring a lower-priority provider just because it appeared in the fast-available set.
- Prompt loading now rejects non-object YAML frontmatter roots, like lists, with a diagnostic instead of silently treating them as missing `model` fields.
- `/chain-prompts` now only restores model and thinking when they actually changed, avoiding redundant state writes and noisy restore notifications on no-op chains.
- `/chain-prompts` now tracks thinking changes caused by model switches even when a step does not set `thinking`, so final restoration stays correct when the runtime clamps or resets thinking during a model change.
- `/chain-prompts` now rejects empty or quote-only step segments explicitly instead of treating them as blank template names.
- Single-command auto-restore now also skips no-op thinking restores and notifications when the runtime is already back on the original thinking level.
- Removed unnecessary exports: `modelSpecMatches` from model-selection.ts and `VALID_THINKING_LEVELS` from prompt-loader.ts are now internal implementation details.
- `/chain-prompts` now correctly ignores ` -- ` and `->` inside quoted per-step arguments instead of misinterpreting them as separators.
- `</else>` is now explicitly rejected with a helpful error message explaining that `<else>` is a separator, not a container.
- Fast-path optimization now correctly includes `</else>` check so standalone invalid tags are caught.
- Empty prompt abort in single-command mode now notifies as "error" instead of "warning" for consistency with chain mode.

## [0.3.1] - 2026-02-08

### Fixed

- Prompts map now initialized at extension load instead of waiting for `session_start`. Commands invoked before the first session event no longer fail with stale empty state.

## [0.3.0] - 2026-02-08

### Added

- **Chain command**: `/chain-prompts` orchestrates multiple prompt templates sequentially, each with its own model, skill, and thinking level. Conversation context flows between steps naturally.
- Per-step args override shared args: `/chain-prompts analyze "error handling" -> fix-plan "focus on perf" -> summarize -- src/main.ts`
- Mid-chain failure rolls back to the original model and thinking level
- Step progress notifications show which step is running
- State isolation: chain uses local variables, never interferes with single-command restore behavior

## [0.2.1] - 2026-01-31

### Fixed

- Thinking level now correctly restored after commands that switch model without a `thinking` field. Previously, running a prompt template that only specified `model` would reset thinking to "off" instead of restoring the original level (e.g., "high").

## [0.2.0] - 2025-01-31

### Added

- **Model fallback**: The `model` field now accepts a comma-separated list of models tried in order
- First model that resolves and has auth configured is used
- Supports mixing bare model IDs and explicit `provider/model-id` specs
- If the current model matches any candidate, it's used without switching
- Single consolidated error when all candidates fail
- Autocomplete shows fallback chain with pipe separator: `[haiku|sonnet]`
- Banner image

## [0.1.0] - 2025-01-12

### Added

- **Model switching** via `model` frontmatter in prompt templates
- **Print mode support**: Commands work with `pi -p "/command args"` for scripting
- **Thinking level control**: `thinking` frontmatter field with levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **Skill injection**: `skill` frontmatter field injects skill content into system prompt via `<skill>` tags
- **Subdirectory support**: Recursive scanning creates namespaced commands like `(user:subdir)`
- **Auto-restore**: Previous model and thinking level restored after response (configurable via `restore: false`)
- **Provider resolution** with priority fallback (anthropic, github-copilot, openrouter)
- Support for explicit `provider/model-id` format
- Fancy TUI display for skill loading with expandable content preview
