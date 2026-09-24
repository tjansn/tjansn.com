# Blindbewertung der „Why local“-Varianten

Die Texte werden vor der inhaltlichen Bewertung mit zufälligen IDs versehen. Harness, Modell, Thinking Effort, Laufzeit und Kosten bleiben dabei verborgen. Bewertet wird ausschließlich der unveränderte Rohtext; sichtbare Selbstprüfungen, Quellenlisten oder andere Meta-Ausgaben werden nicht entfernt. Laufzeit und Kosten erscheinen später als Metadaten und verändern den Qualitätsscore nicht.

Byte-identische Rohtexte werden nur einmal blind bewertet und erhalten anschließend für jede erzeugende Kombination denselben Score und dieselbe Begründung. Damit kann ein identischer Text nicht allein durch Judge-Rauschen unterschiedliche Plätze belegen.

## Gewichtung

| Kategorie | Punkte |
|---|---:|
| Formale Compliance | 15 |
| Inhalt und Faktentreue | 25 |
| Tom-Voice | 35 |
| Kausaler Aufbau und Kompression | 15 |
| Sprache und redaktionelle Präzision | 10 |
| **Gesamt vor Abzügen** | **100** |

### Formale Compliance

Voll erfüllt ist die Kategorie bei 240 bis 260 Wörtern einschließlich Überschrift, genau einem H1-Titel, anschließend ausschließlich Fließtext, deutscher Sprache, keinem Em-Dash, keinem Präteritum und keiner Meta-Ausgabe. Abgeschlossene Benchmark-Aktivitäten stehen unpersönlich im Perfekt; Tools werden als Mittel und nicht als handelnde Akteure formuliert.

- Umfang: 4 Punkte bei 240–260 Wörtern, 3 bei 1–5 Wörtern Abweichung, 1 bei 6–15, sonst 0.
- Ausgabeform: 4 Punkte bei genau einem H1 und ausschließlich folgendem Fließtext, 2 bei genau einer zusätzlichen Strukturart, sonst 0.
- Tempus und Agency: 4 Punkte ohne Verstoß, 2 bei einer bestätigten Occurrence beziehungsweise einem Satz, 1 bei zwei, sonst 0; ein Em-Dash reduziert diesen Teilwert zusätzlich um einen Punkt bis mindestens 0.
- Saubere Übergabe: 3 Punkte für ausschließlich deutschen Artikeltext ohne Meta-Ausgabe, 1 bei einem kleineren Übergabeartefakt, sonst 0.

### Inhalt und Faktentreue

- Reverse Information Paradox als Mechanismus, nicht nur als Datenschutzbehauptung: 6 Punkte
- korrekte und proportionale Verbindung zu DeepSeek-V4-Flash, DwarfStar, pi-ds4, Pi und DRACO: 5 Punkte
- Lernschleife aus Prompts, Korrekturen, Evals, Traces und Memory als kumulierendes, portables Unternehmenswissen: 6 Punkte
- lokale Inferenz ist noch keine vollständig lokale Pipeline: 4 Punkte
- lokale und hybride Systeme sind keine pauschale Anti-Cloud-Position: 4 Punkte

### Tom-Voice

- konkreter Einstieg und früher Reader Contract: 5 Punkte
- Mechanismus vor Konsequenz und Verbindung technischer mit betrieblicher Ebene: 7 Punkte
- natürlicher deutscher Satzfluss mit längeren Haupt-/Nebensatz-Konstruktionen und gezielt gesetzten kurzen Sätzen: 10 Punkte
- konkrete Begriffe und knapp erklärte Systeme statt abstrakter Behauptungen: 5 Punkte
- klare, begrenzte und überprüfbare Position: 4 Punkte
- natürliche Tom-Marker ohne Tic-Sammlung, Marketington oder AI-Tells: 4 Punkte

### Kausaler Aufbau und Kompression

- durchgehende Argumentkette vom Paradox über die eigene Arbeit und Lernschleife bis zur Pipeline-Grenze und Cloud-/Local-Entscheidung: 7 Punkte
- jeder Absatz bringt einen neuen Schritt; technische Namen stützen die These: 5 Punkte
- der Schluss formuliert eine Konsequenz, statt die Einleitung nur zu wiederholen: 3 Punkte

### Sprache und Präzision

- Lesbarkeit, Grammatik und eindeutige Bezüge: 4 Punkte
- konsistente Terminologie und logisch tragfähige Modifikatoren: 3 Punkte
- variierte Satz- und Absatzanfänge, Zeichensetzung und sauberer Absatzfluss: 3 Punkte

## Harte Abzüge und Score-Caps

| Verstoß | Abzug |
|---|---:|
| 1–5 Wörter außerhalb 240–260 | −5 |
| 6–15 Wörter außerhalb | −10 |
| mindestens 16 Wörter außerhalb | −20 und maximal 69 Punkte |
| H1 fehlt oder mehr als ein H1 | −6 |
| zusätzliche Zwischenüberschrift | −4 |
| Liste, Frontmatter, horizontaler Trenner, Quellenliste oder Code-Fence | je Verstoßart −4, maximal −12 |
| Erläuterung oder Meta-Text vor/nach dem Artikel | −6 |
| überwiegend nicht deutsch | −15 und maximal 49 Punkte |
| erster Em-Dash, jeder weitere | −5, danach je −2, maximal −11 |
| Präteritum in eigener Prosa | je −2, maximal −12 |
| abgeschlossene Testaktivität mit „ich“ oder „wir“ | je Satz −5, maximal −10 |
| Tool, Modell oder Benchmark als handelnder Akteur statt als eingesetztes Mittel | je Satz −3, maximal −9 |
| abgeschlossene Aktivität im Präsens statt unpersönlichem Perfekt | je Satz −3, maximal −9 |
| Chatbot-Artefakt, Citation-Leak oder Platzhalter | je Verstoßart −8 |
| kleinere unbelegte Ausschmückung | −5 |
| materielle Erfindung oder Widerspruch zur Quelle | je −20 und maximal 49 Punkte |

Ein leerer Output, eine Ablehnung oder eine bloße Verfahrensbeschreibung erhält den Status „failed“ und keinen regulären Rang. Fehlt einer der fünf inhaltlichen Pflichtblöcke, ist der Score auf 84 begrenzt; bei zwei fehlenden Blöcken auf 69, bei drei oder mehr auf 49.

## Aggregation der drei Blindbewertungen

Judge A und B sind die Primärbewertungen. Unterscheiden sie sich beim Rohscore um höchstens 8 Punkte und in jeder Kategorie um höchstens 4 Punkte, wird ihr Kategorienmittel auf 0,5 Punkte gerundet. Andernfalls wird je Kategorie der Median aus A, B und C verwendet.

Ein Pflichtblock oder ein typisierter harter Verstoß gilt als bestätigt, wenn mindestens zwei von drei Judges ihn nennen. Bei Präteritum, persönlichen Testaktivitäten, Tool-Akteuren und abgeschlossenen Aktivitäten im Präsens wird der Median der drei gemeldeten Counts verwendet. Jede Präteritum-Occurrence zählt einzeln, die übrigen sprachlichen Typen höchstens einmal pro betroffenem Satz. Faktenfehler werden nicht aus bloßen Counts aggregiert: Nach der Blindbewertung wird jede konkrete Evidence ohne Kenntnis von Harness und Modell gegen die Quelle adjudiziert; ein Abzug greift nur, wenn mindestens zwei Judges dieselbe Abweichung melden oder die Evidence bei dieser manuellen Quellenprüfung eindeutig bestätigt wird. Objektive Abzüge für Wortzahl, Markdown-Struktur, Meta-Ausgabe und Em-Dash stammen ausschließlich aus dem Analyse-Script; dessen Regex-Hinweise zu sprachlichen Verstößen sind nur advisory und fließen nicht direkt in den Finalscore ein.

Der Finalscore ist `max(0, Rohscore − objektive Abzüge − bestätigte sprachliche Abzüge − bestätigte Fakten-/Artefaktabzüge)`; anschließend greift der niedrigste anwendbare Cap.

## Ranggleichheit und Nachbarschaftsvergleich

Bei gleichem Finalscore entscheiden nacheinander weniger harte Abzüge, Tom-Voice, Inhalt, Struktur, Sprache, die geringere Abweichung von 250 Wörtern, weniger bestätigte AI-Tells und zuletzt ein direkter Blindvergleich. Harness und Modellname sind niemals Tie-Breaker.

Für jede Rangzeile wird erklärt, warum sie vor der nächstplatzierten Version liegt und wo sie gegenüber der darüberliegenden Version schwächer ist. Entscheidend sind konkrete Textmerkmale oder Verstöße, nicht lediglich der numerische Abstand.

Nach dem rechnerischen Ranking erfolgt dafür ein eigener blinder Nachbarschaftslauf über die bereits sortierten Blind-IDs. Er vergleicht jeden Text direkt mit dem nächsten unterschiedlichen Text sowie mit dem darüberliegenden, darf Scores und Reihenfolge aber nicht mehr verändern. Byte-identische Fassungen erhalten denselben Vergleichstext.
