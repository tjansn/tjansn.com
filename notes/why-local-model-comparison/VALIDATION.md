# Validierung des Schreibvergleichs

Der Vergleich ist rechnerisch und strukturell freigabefähig. Offen bleibt ausschließlich ein visueller Render-Pass, weil die Browsersteuerung in dieser Sitzung keine verfügbaren Browser-Typen gemeldet hat; dieser fehlende Test betrifft die Darstellung, nicht Kandidaten, Scores oder Rangfolge.

## Reconciliation

| Prüfschritt | Ergebnis |
|---|---:|
| Geplante Kombinationen | 111 |
| Gespeicherte Markdown-Rohdateien | 111 |
| Eindeutige Content-Hashes | 106 |
| Regulär gerankte Kombinationen | 110 |
| Regulär gerankte eindeutige Texte | 105 |
| Verfahrensausgaben ohne regulären Rang | 1 |
| Gruppen byte-identischer Texte | 1 Gruppe mit 6 Kombinationen |

Für jede der 111 Kandidatendateien ist der SHA-256 erneut aus dem tatsächlichen Dateibyteinhalt berechnet und mit `BLIND_MAP.json` abgeglichen worden. Alle Dateien sind genau einmal einer Kombination zugeordnet. Die sechs byte-identischen DS4-Ausgaben haben denselben Rang, dieselben Kategorien und denselben Finalscore erhalten.

## Bewertungsprüfung

Alle drei Judge-Dateien enthalten jeweils 106 eindeutige Blind-IDs und gültige ganzzahlige Kategorien innerhalb der vorgegebenen Maxima. Bei 77 Texten ist wegen ausreichender A/B-Übereinstimmung das auf 0,5 Punkte gerundete Kategorienmittel verwendet worden; bei 29 Texten ist der Kategorienmedian aus A, B und C zur Anwendung gekommen. Der mittlere absolute Rohscore-Abstand zwischen A und B beträgt 5,36 Punkte.

Aus 112 Faktenmeldungen der drei Judges sind 67 unterschiedliche Issues gebildet worden. Davon sind 45 gegen den Ausgangsartikel bestätigt und 22 verworfen worden. Ein-Judge-Befunde sind nur übernommen worden, wenn die konkrete Kandidatenformulierung der Quelle eindeutig widerspricht oder eine tragende Tatsache erfindet.

`validate-results.mjs` hat für alle 106 eindeutigen Texte Kategorienaddition, objektive Abzüge, bestätigte Sprachverstöße, Artefakt- und Faktenabzüge, Untergrenze, Caps sowie den kopierten Score jeder Kombination unabhängig nachgerechnet. Der reguläre Scorebereich reicht von 0 bis 96,5 Punkten. Alle 105 gerankten Blind-IDs besitzen genau einen validierten direkten Nachbarschaftsvergleich; interne Blind-IDs kommen in den nutzerseitigen Begründungen nicht mehr vor.

## HTML-Prüfung

`validate-leaderboard.mjs` hat das eingebettete JSON mit 111 eindeutigen Einträgen geparst, 110 reguläre und einen fehlgeschlagenen Status abgeglichen, jedes eingebettete Markdown byteinhaltlich mit seiner Quelldatei verglichen, 17 lokale Referenzen auf Existenz geprüft, 23 HTML-IDs auf Eindeutigkeit kontrolliert und beide Inline-JavaScript-Blöcke syntaktisch kompiliert. Die Rangliste enthält Suche, Harness-, Modell-, Effort- und Statusfilter, Sortierungen, Teilwertungen, direkte Vergleichsbegründungen sowie einen Dialog für den unveränderten Markdown-Text.

Ein interaktiver Desktop-/Mobile-Render-Test ist nicht ausgeführt worden, weil die vorgesehene Browserdiagnose eine leere Browserliste zurückgegeben hat. Vor einer öffentlichen Veröffentlichung empfiehlt sich deshalb noch ein kurzer visueller Smoke-Test in einem realen Browser.

## Interpretationsgrenzen

Jede Kombination hat genau ein Sample geliefert. Das Ergebnis misst diesen deutschen 250-Wörter-Auftrag mit diesem Skill und ist kein allgemeines Modellranking. Effort-Namen sind zwischen Harnesses nicht gleich skaliert; bei einzelnen Pi-Backends führen mehrere sichtbare Effort-Labels sogar zur gleichen technischen Konfiguration. Kosten und Laufzeiten sind nur dort gezeigt, wo der CLI-Lauf sie strukturiert zurückgegeben hat, und beeinflussen die Qualitätsscores nicht.

## Finale Artefakt-Hashes

- `SCORES.json`: `3e67df630b8173be2e12b49aa1851c035e23b40c9615eea507ebd772e5c58d1f`
- `NEIGHBOR_COMPARISON.json`: `c95f21d0ab3719f0b0d51f9036e2ddeb37b7831263e1960447791288510d48e5`
- `FACT_ADJUDICATION.json`: `cbb34fc7c0e629f7310427a49c3eee23b03e72b0c3b24ea2927eda368a5864bd`
- `RUN_METADATA.json`: `e2329bdbbed0180deed3db20e5c2e63da9415739ad40ccbd50556a3742558a8f`
- `leaderboard.html`: `7712c2e397e2e5c1f6f88edce007bb2246ce049002ce911ff7a3b2103eba3b0a`
