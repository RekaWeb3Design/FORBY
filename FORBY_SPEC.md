# FORBY – specifikáció

Always-on-top asztali timer widget. Tauri 2 + React + TypeScript, Windows, 3 monitor.
Ez a dokumentum a jóváhagyott prototípusok alapján készült. Ami itt szerepel, az eldöntött; ami nem, arról kérdezz.

## Általános szabályok

- Kódstílus: arrow function paraméterek mindig zárójelben `(x) => …`, objektum kapcsos zárójelekben nincs belső szóköz: `{a: 1}`.
- A meglévő `src/Face.tsx` a jóváhagyott arc-motor (gömbi vetítés, állapotok, pislogás, brrr, bóbiskolás, olvasás, szín). Bővíteni szabad, a meglévő viselkedést és a konstansokat ne írd át kérés nélkül.
- Animáció: max 30 fps, DOM-attribútumok közvetlen írása ref-eken keresztül, nem React re-render képkockánként.
- Minden fázis után: `tsc --noEmit` hiba nélkül, git commit a fázis nevével, rövid összefoglaló.
- Csak az adott fázist csináld meg. Ha valami a következő fázisba tartozik, ne kezdd el.
- A hangolandó számok legyenek fájl tetején elnevezett konstansok.

## Ablak és elrendezés

- Keret nélküli, átlátszó, always-on-top, árnyék nélkül, nem átméretezhető, látszik a tálcán.
- Ablakméret kb. 240×260 logikai px. Benne: gömb 110 px átmérővel, körülötte gyűrű, fölötte a menü-chipek íve, alatta az idő.
- Átkattintás: az ablak átlátszó részei ne nyeljék el a kattintást. A globális kurzorpozíció (amit a Face már lekérdez) alapján `setIgnoreCursorEvents(true)`, ha a kurzor nincs interaktív elem (gömb, chipek, idő, beállítás-gomb) fölött, `false`, ha igen. Ehhez a megfelelő capability kell.

## Húzás, kattintás, dobás (fizika)

- A Tauri beépített `data-tauri-drag-region` húzását ki kell venni, saját húzás kell.
- Lenyomás a gömbön: ha a kurzor 4 px-nél kevesebbet mozdul felengedésig, az **kattintás**, ha többet, **húzás**.
- Húzás: képkockánként a globális kurzorpozícióból számolt ablakpozíció (`setPosition`, fizikai px), a megfogási pont megtartásával.
- Elengedés: az utolsó ~90 ms mintáiból sebesség, sebességkorláttal. Utána lendülettel csúszik tovább, súrlódással lassul (prototípus: `v *= 0.9965^dt`, dt ms-ben).
- Határok a **gömb körére** vonatkoznak (nem az ablakra), a monitorok munkaterülete alapján (`availableMonitors`, `workArea`, ha van, különben a teljes méret):
  - Vízszintesen: a legszélső bal monitor bal széle és a legszélső jobb monitor jobb széle kemény fal, visszapattanás 0.55 visszaverődéssel. Monitorok között szabad átjárás.
  - Függőlegesen: annak a monitornak a teteje és alja, amelyiken a gömb közepe van. Legfeljebb a monitor magasságának 5%-áig lóghat ki, ott kemény ütközés 0.45 visszaverődéssel, és ha kint van, rugó húzza vissza teljesen a képernyőre.
- Eltérő DPI-jű monitorok: a scaleFactor-t gyorsítótárazd, és rendszeresen frissítsd, a számolás fizikai pixelben menjen.
- Arc-reakciók (a Face új, opcionális bemenete, például egy mozgás-ref, re-render nélkül):
  - Húzás és repülés közben a szemek és a száj a mozgással **ellentétes irányba** csúsznak a gömbön (yaw/pitch = −sebesség × szorzó, korlátozva).
  - A gömb a mozgás irányában kissé megnyúlik (max ~22%).
  - Gyors mozgásnál „whoa” arc: magasabb pill-szemek (44) és egy kis kerek „o” száj.
  - Falnak ütközéskor rövid összenyomódás az ütközés irányában (~240 ms).
  - Kattintáskor „koppintás”: rövid összenyomódás és visszapattanás (~320 ms).

### Játék mód

- A dobás-fizika (lendület, pattogás, 5%-os kilógás és rugó), valamint az arc-reakciók közül a lemaradás, a nyúlás, a whoa és az ütközési lapulás a **Játék mód** része. Alapból be van kapcsolva (beállítás: „Megjelenés és időzítés” fül).
- Kikapcsolt Játék módban: sima húzás, elengedéskor ott marad, ahol van, lendület nélkül; a gömb nem lóghat ki a monitor munkaterületéről; nincs lemaradás, nyúlás, whoa, ütközési lapulás.
- A koppintás-reakció és a kurzorkövető szem mindkét módban megmarad.

## Módok és állapotgép

UI-állapotok: `idle`, `pickMode`, `pickDur`, `run`, `paused`, `alarm`, `summary`.

Kattintás a gömbre:

| Állapot | Kattintás hatása |
|---|---|
| idle | pickMode (koppintás-reakcióval) |
| pickMode | vissza idle-be |
| pickDur | indítás |
| run | paused |
| paused | vissza run-ba |
| alarm | summary |
| summary | idle |

Módok:

- **Timer:** időtartam választása, visszaszámol. 0-nál `alarm`: a visszaszámlálás mínuszba fut tovább (`-0:12`, korall színnel), amíg rá nem kattintasz.
- **Stopper:** azonnal indul, felfelé számol, nincs cél.
- **Cél-stopper:** időtartam választása, felfelé számol. A cél után túlóra: a nagy szám a valós teljes idő, korall színnel, alatta `Cél 5:00, +3:12`. Minden teljes kör után jelez.
- **Pomodoro:** azonnal indul, fókusz → szünet → fókusz… magától vált, a fókusz és a szünet hossza a beállításokból jön (alapból 25/5).

Chipek a gömb fölött, ívben, szorosan egymás mellett, középre igazítva (szélesség a felirat alapján, 6 px rés):

- pickMode: `Timer`, `Stopper`, `Cél-stopper`, `Pomodoro`
- pickDur: `Vissza`, `Egyéni`, `5`, `15`, `25`, `45`, `60`. Számos chipre kattintva a kiválasztott idővel azonnal indul; az `Egyéni` megnyitja a beviteli mezőt, fókusszal.
- paused: `Folytat`, `Leállít` (a Leállít → summary)

Időtartam finomhangolása pickDur-ban: görgő a gömb fölött ±1 perc (1–600), vagy kattintás a számra → beviteli mező (`45`, `90`, `1:30` formátum), Enter indít, Esc bezár, hibás érték piros kerettel.

Összesítő (summary), a hover-mosolygós arccal:

- Timer, cél-stopper: nagy szám a teljes idő, alatta `Összesen X`, és `Cél Y, túlóra +Z` vagy `Cél Y, Z maradt`.
- Pomodoro: nagy szám az összes fókuszidő, alatta a teljes pomodorók száma.
- Stopper: teljes idő.

Arc-állapotok hozzárendelése: idle → idle (hoverre hover), run → focus (olvasó animációval focusRead), cél-stopper túlórában → overtime, pomodoro szünet → break, paused → pause, alarm → alarm, summary → hover arc.

Időformátum: `m:ss`, egy óra fölött `h:mm:ss`, tabuláris számjegyek.

## Gyűrű

- A gömb körül kis réssel (prototípusban a gömb r=90, a gyűrű r=104, a vonal 5 egység a 200-as viewBoxban), 12 órától indul, óramutató szerint telik.
- Halvány sáv mindig látszik (#888780, 20%).
- Timer, cél-stopper, pomodoro: telik az aktuális szakasz arányában, szín: #1D9E75.
- Cél-stopper túlórában: teli kör, rajta korall (#D85A30) ív kezdi elölről felülírni.
- Stopper: egy rövid szakasz (a kerület ~7%-a), ami percenként egyet fordul, folyamatos mozgással (a percen belüli pozíciót mutatja).
- Pomodoro szünet: lassan körbe váltó színek (hsl, ~4 mp alatt egy teljes kör).
- Paused: szolid #888780, mozdulatlan.
- Alarm: teli korall kör, halvány alapfényerő, és a brrr-rel szinkronban lassan felpulzál (ALARM_CYCLE 3400 ms, a ciklus 65%-ától).

## Beállítások

- Kis kerek gomb (három pötty) a gyűrű **bal alsó** részén, minimális átfedéssel.
- Külön kis ablakot nyit FORBY mellett, **két füllel**, a panel magassága a nagyobbik fülhöz igazodik, semmi ne legyen levágva:
  1. **Megjelenés és időzítés:** gömb színe (5 preset + egyedi színválasztó), olvasó animáció fókusz alatt (alapból ki), pomodoro fókusz (5–60 perc, 5-ös lépés) és szünet (1–20 perc) csúszkával, „Játék mód” kapcsoló (alapból be).
  2. **Riasztások:** hang be/ki és hangválasztó egy sorban lejátszás gombbal; hangerő (alapból 80%); saját hang felvétele (max 5 mp) vagy hangfájl feltöltése; tálca-villogás (alapból be); Windows értesítés (alapból ki); odaugrik a kurzorhoz (alapból ki).
- A beállítások tartósan mentve (pl. tauri-plugin-store), és azonnal érvényesülnek a fő ablakban.

## Riasztások

- Hangok Web Audio-val szintetizálva (prototípus szerint): Csengő (880/660/880/1320 Hz sorozat felhanggal), Harang (523 és 659 Hz inharmonikus felhangokkal), Pittyegés (3× 1200 Hz square), Gong (110/220/331 Hz), valamint Saját hang (a felvett vagy feltöltött fájl az app adatmappájában tárolva).
- Mikor szól: timer lejártakor, majd 10,2 mp-enként, amíg le nem zárod; cél-stopper minden teljes körénél; pomodoro váltásnál halkabban (70%).
- Saját hang: felvétel max 5 mp, feltöltött fájl max 5 MB és max 10 mp; csak lejátszható (dekódolható) hang menthető.
- Tálca-villogás (ha be van kapcsolva): `requestUserAttention` timer lejártakor (alarm), a cél-stopper első körénél és pomodoro-váltáskor. Alarm-nál lezáráskor mindenképp megszűnik; a másik kettőnél akkor, amikor FORBY fókuszt kap vagy rákattintasz, de legkésőbb 30 mp után magától.
- Windows értesítés (ha be van kapcsolva), rövid toast „FORBY” címmel:
  - timer lejártakor: „Lejárt az idő”;
  - cél-stopper: csak az első körnél, „Elérted a célt (5:00)”; a további köröknél csak hang, toast nem;
  - pomodoro-váltáskor: „Szünet következik” / „Vissza a fókuszhoz”.
- Odaugrás (ha be van kapcsolva), csak timer lejártakor: FORBY animálva a kurzor monitorára, a kurzor közelébe ugrik (a munkaterületen belül), lezárás után visszatér az eredeti helyére. Ha közben arrébb húzod, ott marad, ahová tetted.

## Indítás és tálcaikon

- „Indítás a géppel” kapcsoló a „Megjelenés és időzítés” fülön, alapból be. A fő ablak induláskor és minden változáskor a beállításhoz igazítja a HKCU `Run` bejegyzést („FORBY”). Dev buildben nem regisztrálja magát. Eltávolításkor az installer törli a bejegyzést.
- Tálcaikon (értesítési terület), „FORBY” tooltippel. Bal kattintás: FORBY előjön és fókuszt kap. Jobb kattintás menü:
  - „Beállítások”: megnyitja a beállítás-ablakot FORBY mellett (ha nyitva van, előre hozza);
  - „FORBY megkeresése”: a gömb közepét a fő monitor munkaterületének közepére teszi, és ott marad (egy riasztás utáni visszaugrás elmarad);
  - „Kilépés”.

## Telepítő

- NSIS, felhasználói szintű telepítés (admin jog nélkül, `%LOCALAPPDATA%`).

## Fázisok

1. Saját húzás, kattintás/húzás szétválasztása, dobás-fizika a határokkal, arc-reakciók (lemaradás, nyúlás, whoa, ütközés, koppintás), átkattintás az átlátszó részeken, új ablakméret. A teszt-billentyűk (1–6) maradnak.
2. Timer-motor és állapotgép, chipek, időtartam-választás (chip, görgő, beviteli mező), szünet, folytatás, leállítás, összesítő, idő és segédszövegek. A teszt-billentyűk megszűnnek.
3. Gyűrű az összes állapottal.
4. Beállítás-gomb, beállítás-ablak két füllel, tartós mentés.
5. Riasztások: hangok, saját hang, tálca-villogás, értesítés, odaugrás.
6. Indítás a géppel (autostart), tálcaikon kilépés menüvel.
