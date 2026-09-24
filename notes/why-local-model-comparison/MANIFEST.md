# „Why local“: Modell- und Effort-Matrix

Für jede Kombination ist ein isolierter, zustandsloser CLI-Subagent mit demselben byte-identischen Auftrag aus [TASK.md](TASK.md) gestartet worden. Jeder Lauf hat den Skill `tom-writing-voice` explizit erhalten und durfte den Ausgangsartikel sowie die vom Skill verlangten Referenzen lesen, aber keine Dateien verändern. Die Modellantwort ist unverändert als Markdown gespeichert worden; auch Meta-Ausgaben oder formale Verstöße bleiben erhalten.

Die Live-Inventur und die Läufe sind am 16. Juli 2026 mit Codex CLI `0.144.0`, Pi `0.80.6` und Claude Code `2.1.211` erfolgt.

SHA-256 des unveränderten Schreibauftrags: `55e3f2e8f1ce7eea609bf0f1ac15214c1b40bc1cd9725b8d0080725ef6e042c4`.

SHA-256 des als Faktenquelle verwendeten Ausgangsartikels `warum-lokale-ki.html`: `712985b8ddf86674babf58033145609b826c1e3ebd6cd73c4917387f20a729e6`.

Kombinierter SHA-256 aller Dateien des verwendeten `tom-writing-voice`-Skillpakets, sortiert und ohne `.git`: `cb7c5d5dc72383cd7b25f4f7bd251c1b901a1d1b8f69bd69bf512658ec4ab71a`.

Vor Beginn der Blindbewertung sind außerdem Rubrik (`9d4923d5cd8ab7bf73de1216194b629bda89814281f6e96bd7cc103232b032e0`), Judge-Auftrag (`290422049440796bf7f72e8b6351040a0204c8ec25ed00dcde3b7482e98f616a`) und mechanisches Analyse-Script (`2f79d8359648bcd02688c0be8fe1538ef6fde2df9c4bdf3408cbae07929e5f4f`) per SHA-256 eingefroren worden.

## Geplante Matrix

### Codex: 33 Kombinationen

| Modell | Thinking Efforts |
|---|---|
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.5` | low, medium, high, xhigh |
| `gpt-5.4` | low, medium, high, xhigh |
| `gpt-5.4-mini` | low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | low, medium, high, xhigh |

`gpt-5.2` ist nicht im authentifizierten Live-Katalog enthalten gewesen und ist deshalb nicht verwendet worden. `codex-auto-review` ist ein verborgenes Spezialmodell für Reviews und kein Artikelgenerator.

### Pi: 58 Kombinationen

| Provider und Modelle | Thinking Efforts |
|---|---|
| `openai-codex/gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` | off, minimal, low, medium, high, xhigh |
| `openai-codex/gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` | off, minimal, low, medium, high, xhigh, max |
| `ds4/deepseek-v4-flash` | off, minimal, low, medium, high, xhigh |
| `ollama/qwen3.6:latest` | off, minimal, low, medium, high |
| `ollama/gemma4:latest` | off |
| `ollama/hf.co/prithivMLmods/VibeThinker-3B-GGUF:Q8_0` | off |

Pi bildet bei Codex und DS4 `minimal` intern auf `low` ab. Bei `qwen3.6` verändern die fünf sichtbaren Effort-Labels den HTTP-Request nicht. Die Varianten bleiben trotzdem als einzelne Samples in der Matrix, werden im Leaderboard aber als semantische Duplikate gekennzeichnet.

### Claude: 20 Kombinationen

| CLI-Alias | Aufgelöstes Modell | Thinking Efforts |
|---|---|---|
| `haiku` | `claude-haiku-4-5-20251001` | low, medium, high, xhigh, max |
| `sonnet` | `claude-sonnet-5` | low, medium, high, xhigh, max |
| `opus` | `claude-opus-4-8` | low, medium, high, xhigh, max |
| `fable` | `claude-fable-5` | low, medium, high, xhigh, max |

## Bewertungsgrenzen

Jede Kombination liefert nur ein Sample. Das Ergebnis bewertet deshalb diesen deutschen 250-Wörter-Auftrag und keine allgemeine Modellleistung. Effort-Bezeichnungen sind zwischen Harnesses nicht numerisch vergleichbar. Kosten und Laufzeit werden getrennt vom Qualitätsscore gezeigt. Fehlgeschlagene oder leere Läufe erscheinen als Zuverlässigkeitsstatus, erhalten aber keinen künstlichen Schreibscore von null.

## Tatsächlicher Laufstatus

Alle 111 geplanten Kombinationen haben eine unveränderte Markdown-Rohdatei geliefert. Davon enthalten 110 einen bewertbaren Artikel; die VibeThinker-Ausgabe besteht stattdessen aus 5.792 gerenderten Wörtern interner Überlegung und mehreren Entwurfsfragmenten und erhält deshalb gemäß Rubrik keinen regulären Rang. Die übrigen 110 Versionen verteilen sich auf 105 unterschiedliche Texte, weil alle sechs `ds4/deepseek-v4-flash`-Effort-Ausgaben byte-identisch sind. Ihr gemeinsamer SHA-256 lautet `0ceeabd71a6e27554bcbff8e00dec4b9118e3be7fd39c866d1819296bb7381a1`.

Vier reguläre Generierungsläufe haben genau einen Wiederholungsversuch benötigt: Codex `gpt-5.6-sol/ultra` nach einem Timeout, Pi `openai-codex/gpt-5.4/medium` und `ollama/gemma4:latest/off` nach einer leeren ersten Ausgabe sowie Claude `sonnet/max` nach einem Timeout. Vor dem ersten Claude-Lauf sind außerdem zwei nicht modellbedingte Adapter-Preflight-Fehler aufgetreten; sie werden nicht als Modell-Retry gezählt. Keine dieser Wiederholungen verändert den Qualitätsscore.

Nur Claude Code hat für alle 20 erfolgreichen Aufrufe strukturierte Kosten gemeldet; deren Summe beträgt 26,7693419 US-Dollar. Codex und Pi haben in diesem Lauf keine direkt vergleichbaren Kostenwerte geliefert. Laufzeitfelder liegen ebenfalls nur für einen Teil der Aufrufe vor, weshalb fehlende Angaben weder als null noch als Vorteil interpretiert werden.

Die Blindbewertung ist über 106 eindeutige Rohtexte erfolgt. Die drei validierten Judge-Dateien haben die SHA-256-Werte `1ad836ebf4e32760112a0eeb959f06294f8a4907fb4a572a4c27c329c0b4981b`, `124a1ec326bfb786ba03acfa423d536d1146e2b555f27071f74cfe8838190b8d` und `450112b7b65d121ca56a42a944187237e658f49ba1aee7e2ce0ef9538914e448`.

## Ergebnisartefakte

Den ersten Platz belegt Codex mit `gpt-5.5/low` und 96,5 Punkten, gefolgt von Codex `gpt-5.6-luna/high` mit 95 Punkten und Claude `claude-fable-5/xhigh` mit 94 Punkten. Das beste Pi-Ergebnis ist `openai-codex/gpt-5.6-terra/max` auf Platz 5 mit 93,5 Punkten. Diese Reihenfolge gilt ausschließlich für das einzelne Sample dieses Auftrags.

- [Interaktives Leaderboard](leaderboard.html)
- [Validierungsbericht](VALIDATION.md)
- [Finale Score-Daten](SCORES.json), SHA-256 `3e67df630b8173be2e12b49aa1851c035e23b40c9615eea507ebd772e5c58d1f`
- [Direkte Nachbarschaftsvergleiche](NEIGHBOR_COMPARISON.json), SHA-256 `c95f21d0ab3719f0b0d51f9036e2ddeb37b7831263e1960447791288510d48e5`
