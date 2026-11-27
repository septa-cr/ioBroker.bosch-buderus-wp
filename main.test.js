'use strict';

/**
 * Tests für die Hilfsfunktionen und die Umwandlung der API-Werte in main.js.
 * Die Tests laufen ohne ioBroker und ohne Gerät: Der Adapter-Kern (@iobroker/adapter-core) wird durch eine
 * einfache Attrappe ersetzt, es werden keine Verbindungen aufgebaut.
 */

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const names = require('./lib/names.json');
const ioPackage = require('./io-package.json');
const packageJson = require('./package.json');

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/** Attrappe für @iobroker/adapter-core: nur das, was der Konstruktor des Adapters braucht */
class FakeAdapter extends EventEmitter {
	constructor() {
		super();
		this.namespace = 'bosch-buderus-wp.0';
		this.common = { version: '9.9.9' };
		this.log = { debug() {}, info() {}, warn() {}, error() {} };
	}
}

/**
 * Lädt main.js mit der Attrappe statt dem echten Adapter-Kern.
 *
 * @returns {any} Das, was main.js exportiert (Fabrik für den Adapter plus helpers)
 */
function loadMain() {
	const mainPath = require.resolve('./main.js');
	delete require.cache[mainPath];
	// @ts-expect-error _load ist nicht in den Typen, wird hier bewusst für die Attrappe genutzt
	const originalLoad = Module._load;
	// @ts-expect-error siehe oben
	Module._load = function (request, ...rest) {
		if (request === '@iobroker/adapter-core') {
			return { Adapter: FakeAdapter };
		}
		return originalLoad.call(this, request, ...rest);
	};
	try {
		return require(mainPath);
	} finally {
		// @ts-expect-error siehe oben
		Module._load = originalLoad;
	}
}

const createAdapter = loadMain();
const h = createAdapter.helpers;

describe('Hilfsfunktionen', () => {
	describe('formatDate', () => {
		it('gibt JJJJ-MM-TT mit führenden Nullen zurück', () => {
			expect(h.formatDate(new Date(2026, 0, 5))).to.equal('2026-01-05');
			expect(h.formatDate(new Date(2026, 10, 26))).to.equal('2026-11-26');
		});
	});

	describe('isSlowPath', () => {
		it('erkennt Verlaufsdaten und die WLAN-Liste', () => {
			expect(h.isSlowPath('/recordings/heatSources/hs1/actualPower')).to.equal(true);
			expect(h.isSlowPath('/gateway/wifi/apList')).to.equal(true);
		});
		it('lässt normale Pfade im Minutentakt', () => {
			expect(h.isSlowPath('/system/appliance/temperature')).to.equal(false);
			expect(h.isSlowPath('/gateway/wifi/pairingStatus')).to.equal(false);
		});
	});

	describe('normalizeUnit', () => {
		it('wandelt Einheiten der API in die Schreibweise von ioBroker um', () => {
			expect(h.normalizeUnit('C')).to.equal('°C');
			expect(h.normalizeUnit('mins')).to.equal('min');
			expect(h.normalizeUnit('db')).to.equal('dB');
		});
		it('entfernt die Einheit bei Datumsteilen (leerer Text)', () => {
			expect(h.normalizeUnit('day')).to.equal('');
			expect(h.normalizeUnit('month')).to.equal('');
			expect(h.normalizeUnit('year')).to.equal('');
		});
		it('lässt andere Einheiten unverändert', () => {
			expect(h.normalizeUnit('kWh')).to.equal('kWh');
			expect(h.normalizeUnit(undefined)).to.equal(undefined);
		});
	});

	describe('numberRole', () => {
		it('wählt die Rolle nach der Einheit', () => {
			expect(h.numberRole('°C', '/x')).to.equal('value.temperature');
			expect(h.numberRole('kWh', '/x')).to.equal('value.energy');
			expect(h.numberRole('W', '/x')).to.equal('value.power');
			expect(h.numberRole('bar', '/x')).to.equal('value');
		});
		it('erkennt Luftfeuchtigkeit nur bei Prozent und passendem Pfad', () => {
			expect(h.numberRole('%', '/heatingCircuits/hc1/actualHumidity')).to.equal('value.humidity');
			expect(h.numberRole('%', '/heatSources/hs1/actualModulation')).to.equal('value');
		});
	});

	describe('toId', () => {
		it('bildet aus dem API-Pfad die Datenpunkt-ID', () => {
			expect(h.toId('/heatSources/hs1/actualPower')).to.equal('heatSources.hs1.actualPower');
		});
		it('ersetzt unzulässige Zeichen durch Unterstriche', () => {
			expect(h.toId('/signals/A B')).to.equal('signals.A_B');
		});
	});

	describe('valueKey', () => {
		it('ignoriert Groß-/Kleinschreibung, Unterstriche und Sonderzeichen', () => {
			expect(h.valueKey('activeDHW')).to.equal(h.valueKey('activeDhw'));
			expect(h.valueKey('IUFH_240v')).to.equal('iufh240v');
			expect(h.valueKey('Not_Commissioned')).to.equal('notcommissioned');
		});
	});

	describe('allowedValues', () => {
		it('liefert die vom Gerät gemeldete Liste als Texte', () => {
			expect(h.allowedValues({ allowedValues: ['off', 1] })).to.deep.equal(['off', '1']);
		});
		it('liefert undefined, wenn es keine Liste gibt', () => {
			expect(h.allowedValues({})).to.equal(undefined);
			expect(h.allowedValues(undefined)).to.equal(undefined);
		});
	});
});

describe('Namen', () => {
	describe('nameFor', () => {
		it('findet feste Einträge', () => {
			expect(h.nameFor('/heatSources/flameStatus')).to.equal(names.paths['/heatSources/flameStatus']);
		});
		it('setzt bei Vorlagen die Nummer in allen Sprachen ein', () => {
			const result = h.nameFor('/heatingCircuits/hc2/pumpStatus');
			for (const lang of LANGUAGES) {
				expect(result[lang]).to.include('2');
				expect(result[lang]).to.not.include('{n}');
			}
			expect(result.en).to.equal('Heating circuit 2: Pump status');
		});
		it('gibt bei unbekannten Pfaden den Pfad selbst zurück', () => {
			expect(h.nameFor('/gibt/es/nicht')).to.equal('/gibt/es/nicht');
		});
	});

	describe('folderName', () => {
		it('findet feste Ordnernamen', () => {
			expect(h.folderName('heatingCircuits').de).to.equal('Heizkreise');
		});
		it('füllt nummerierte Ordner', () => {
			expect(h.folderName('hc3').de).to.equal('Heizkreis 3');
			expect(h.folderName('HC1').de).to.equal('Heizkreis 1');
		});
		it('gibt unbekannte Ordner unverändert zurück', () => {
			expect(h.folderName('irgendwas')).to.equal('irgendwas');
		});
	});

	describe('fieldName', () => {
		it('übersetzt bekannte Feldnamen und überspringt value/values', () => {
			const result = h.fieldName('values.0.moduleId');
			expect(result.en).to.equal('[0] Module ID');
		});
		it('gibt den Pfad zurück, wenn kein Teil bekannt ist', () => {
			expect(h.fieldName('foo.bar')).to.equal('foo.bar');
		});
	});

	describe('PC0 und PC1', () => {
		it('heißen Primärkreispumpe und Heizkreispumpe', () => {
			expect(h.nameFor('/signals/SRC.CUHP.PC0ConnectedToLIN').de).to.include('Primärkreispumpe (PC0)');
			expect(h.nameFor('/signals/SRC.CUHP.PC1ConnectedToLIN').de).to.include('Heizkreispumpe (PC1)');
		});
	});
});

describe('statesFor (Werteliste mit Texten)', () => {
	it('liefert Texte für die vom Gerät gemeldeten Werte', () => {
		const states = h.statesFor('/heatSources/hs1/refrigerant/status', ['idle', 'heating', 'defrost']);
		expect(Object.keys(states)).to.deep.equal(['idle', 'heating', 'defrost']);
		expect(states.heating).to.equal(names.stateTexts.heating);
	});

	it('findet Werte auch bei abweichender Schreibweise des Geräts und behält dessen Schreibweise', () => {
		const states = h.statesFor('/heatSources/emStatus', ['notConnected', 'activeDhw']);
		expect(states.activeDhw).to.equal(names.stateTexts.activeDHW);
	});

	it('nutzt die Liste aus names.json, wenn das Gerät keine meldet', () => {
		const states = h.statesFor('/heatSources/hs1/refrigerant/status');
		expect(typeof states).to.equal('object');
		expect(states.defrost).to.equal(names.stateTexts.defrost);
	});

	it('kennt die Werte, die Buderus-Geräte für den Kältekreis melden (off, dhw, pool, pool_heat)', () => {
		const device = ['off', 'heating', 'cooling', 'dhw', 'pool', 'pool_heat', 'defrost', 'alarm'];
		const states = h.statesFor('/heatSources/hs1/refrigerant/status', device);
		expect(Object.keys(states)).to.deep.equal(device);
		expect(states.dhw).to.equal(names.stateTexts.dhw);
		// ohne Liste des Geräts kommen die Werte aus names.json
		const fallback = h.statesFor('/heatSources/hs1/refrigerant/status');
		for (const value of ['off', 'dhw', 'pool', 'pool_heat']) {
			expect(fallback[value], value).to.equal(names.stateTexts[value]);
		}
	});

	it('findet Pfade mit Nummer über die Vorlage', () => {
		expect(typeof h.statesFor('/heatSources/hs3/refrigerant/status')).to.equal('object');
	});

	it('lässt Werte ohne Text weg', () => {
		const states = h.statesFor('/heatSources/hs1/refrigerant/status', ['heating', 'gibtEsNicht']);
		expect(Object.keys(states)).to.deep.equal(['heating']);
	});

	it('gibt undefined zurück, wenn kein Wert einen Text hat', () => {
		expect(h.statesFor('/heatSources/hs1/refrigerant/status', ['gibtEsNicht'])).to.equal(undefined);
	});

	it('gibt für Pfade ohne feste Werte undefined zurück (auch reine Ein/Aus-Werte)', () => {
		expect(h.statesFor('/gibt/es/nicht', ['a', 'b'])).to.equal(undefined);
		expect(h.statesFor('/heatSources/flameStatus', ['off', 'on'])).to.equal(undefined);
	});
});

describe('flatten', () => {
	it('zerlegt Objekte und Listen in einzelne Werte', () => {
		/** @type {[string, any][]} */
		const out = [];
		h.flatten({ a: 1, b: { c: 'x' }, d: [{ e: true }, { e: false }] }, '', out);
		expect(out).to.deep.equal([
			['a', 1],
			['b.c', 'x'],
			['d.0.e', true],
			['d.1.e', false],
		]);
	});

	it('legt Listen einfacher Werte als Text ab', () => {
		const out = [];
		h.flatten({ modes: ['ch', 'dhw'] }, '', out);
		expect(out).to.deep.equal([['modes', '["ch","dhw"]']]);
	});

	it('überspringt leere Listen, null und die Zusatzfelder der API', () => {
		const out = [];
		h.flatten(
			{ id: '/x', type: 'stringValue', writeable: 0, uri: 'u', empty: [], nothing: null, keep: 1 },
			'',
			out,
		);
		expect(out).to.deep.equal([['keep', 1]]);
	});

	it('ersetzt unzulässige Zeichen in Schlüsseln', () => {
		const out = [];
		h.flatten({ 'a b': 1 }, '', out);
		expect(out).to.deep.equal([['a_b', 1]]);
	});
});

describe('extractSeries', () => {
	const response = {
		values: [
			{
				sampleRate: 'P1D',
				startTime: '2026-11-29T00:00:00',
				recording: [
					{ y: 20, c: 4 },
					{ y: 0, c: 0 },
				],
			},
			{ sampleRate: 'P1M', startTime: '2026-11-01T00:00:00', recording: [{ y: 100, c: 10 }] },
		],
	};

	it('bildet Tage mit Datum, auch über einen Monatswechsel', () => {
		const series = h.extractSeries(response, 'P1D', false);
		expect(series).to.deep.equal([
			{ date: '2026-11-29', value: 20, samples: 4 },
			{ date: '2026-11-30', value: 0, samples: 0 },
		]);
	});

	it('bildet Monate', () => {
		expect(h.extractSeries(response, 'P1M', false)).to.deep.equal([{ date: '2026-11', value: 100, samples: 10 }]);
	});

	it('bildet den Durchschnitt und gibt bei 0 Messungen null zurück', () => {
		const series = h.extractSeries(response, 'P1D', true);
		expect(series[0].value).to.equal(5);
		expect(series[1].value).to.equal(null);
	});

	it('liefert bei unbrauchbarer Antwort eine leere Liste', () => {
		expect(h.extractSeries({}, 'P1D', false)).to.deep.equal([]);
		expect(h.extractSeries(undefined, 'P1D', false)).to.deep.equal([]);
	});
});

describe('convertValue', () => {
	const adapter = createAdapter();

	it('übernimmt einen normalen Messwert mit Einheit', () => {
		const result = adapter.convertValue({
			type: 'floatValue',
			value: 21.5,
			unitOfMeasure: 'C',
			state: [{ open: -32768, short: 32767 }],
		});
		expect(result).to.deep.equal({ val: 21.5, type: 'number', unit: '°C' });
	});

	it('macht aus Sonderwerten (Fühlerfehler) bei Messwerten null', () => {
		const data = { type: 'floatValue', unitOfMeasure: 'C', state: [{ open: -32768, short: 32767 }] };
		expect(adapter.convertValue({ ...data, value: -32768 }).val).to.equal(null);
		expect(adapter.convertValue({ ...data, value: 32767 }).val).to.equal(null);
	});

	it('akzeptiert die Liste state auch als einfaches Objekt', () => {
		const data = { type: 'integerValue', unitOfMeasure: 'l/h', state: { LOW_FLOW: 65535 } };
		expect(adapter.convertValue({ ...data, value: 65535 }).val).to.equal(null);
		expect(adapter.convertValue({ ...data, value: 800 }).val).to.equal(800);
	});

	it('behält bei Zahlen ohne Einheit den Wert und liefert die Zustandstexte', () => {
		const result = adapter.convertValue({
			type: 'integerValue',
			value: 6,
			state: [{ Not_Commissioned: 6, Commissioned: 0 }],
		});
		expect(result.val).to.equal(6);
		expect(result.type).to.equal('number');
		expect(result.states).to.deep.equal({ 6: 'Not_Commissioned', 0: 'Commissioned' });
	});

	it('macht aus einer Zahl ohne Einheit mit nur FALSE (0) und TRUE (1) einen Wahrheitswert', () => {
		const data = { type: 'integerValue', state: [{ FALSE: 0, TRUE: 1 }] };
		expect(adapter.convertValue({ ...data, value: 0 })).to.deep.equal({ val: false, type: 'boolean' });
		expect(adapter.convertValue({ ...data, value: 1 })).to.deep.equal({ val: true, type: 'boolean' });
	});

	it('lässt andere Zustandslisten und unerwartete Werte als Zahl stehen', () => {
		const other = adapter.convertValue({ type: 'integerValue', value: 1, state: [{ OFF: 0, ON: 1 }] });
		expect(other.type).to.equal('number');
		expect(other.states).to.deep.equal({ 0: 'OFF', 1: 'ON' });
		const odd = adapter.convertValue({ type: 'integerValue', value: 5, state: [{ FALSE: 0, TRUE: 1 }] });
		expect(odd.type).to.equal('number');
		expect(odd.val).to.equal(5);
	});

	it('wandelt "true" und "false" in Wahrheitswerte', () => {
		expect(adapter.convertValue({ type: 'stringValue', value: 'true' })).to.deep.equal({
			val: true,
			type: 'boolean',
		});
		expect(adapter.convertValue({ type: 'stringValue', value: 'false' })).to.deep.equal({
			val: false,
			type: 'boolean',
		});
	});

	it('legt Texte als Text ab', () => {
		expect(adapter.convertValue({ type: 'stringValue', value: 'heating' })).to.deep.equal({
			val: 'heating',
			type: 'string',
		});
	});

	it('legt Antworten ohne einfachen Wert als JSON ab, ohne id und writeable', () => {
		const result = adapter.convertValue({ id: '/x', writeable: 0, type: 'arrayData', values: ['a'] });
		expect(result.type).to.equal('string');
		expect(JSON.parse(String(result.val))).to.deep.equal({ type: 'arrayData', values: ['a'] });
	});

	it('legt Objekte als JSON ab', () => {
		const result = adapter.convertValue({ type: 'stringValue', value: { a: 1 } });
		expect(result).to.deep.equal({ val: '{"a":1}', type: 'string' });
	});
});

describe('Diagnosebericht', () => {
	/**
	 * Adapter mit Mitschrift der geschriebenen Zustände.
	 *
	 * @param {boolean} enabled - Bericht eingeschaltet
	 * @returns {{ adapter: any, written: { id: string, state: any }[] }} Adapter und geschriebene Zustände
	 */
	function createDiagnosisAdapter(enabled) {
		const adapter = createAdapter();
		/** @type {{ id: string, state: any }[]} */
		const written = [];
		adapter.diagnosisEnabled = enabled;
		adapter.setStateChangedAsync = async (/** @type {string} */ id, /** @type {any} */ state) => {
			written.push({ id, state });
		};
		return { adapter, written };
	}

	it('schreibt nichts, wenn der Bericht ausgeschaltet ist', async () => {
		const { adapter, written } = createDiagnosisAdapter(false);
		adapter.recordDiagnosis('/gateway/brand', { value: 'Buderus' });
		await adapter.writeDiagnosis();
		expect(written).to.deep.equal([]);
		expect(adapter.diagnosis.size).to.equal(0);
	});

	it('enthält Version, erlaubte Geräteeigenschaften, Pfade ohne Namen und Werte ohne Text', async () => {
		const { adapter, written } = createDiagnosisAdapter(true);
		adapter.recordDiagnosis('/gateway/brand', { value: 'Buderus' });
		adapter.recordDiagnosis('/gibt/es/nicht', { value: 1 });
		adapter.recordDiagnosis('/devices/device1/type', { value: 'XLOW_RF', allowedValues: ['ETRV', 'XLOW_RF'] });
		await adapter.writeDiagnosis();

		expect(written.length).to.equal(1);
		expect(written[0].id).to.equal('info.diagnosis');
		expect(written[0].state.ack).to.equal(true);
		const report = JSON.parse(written[0].state.val);
		expect(report.adapter).to.equal('9.9.9');
		expect(report.pathsQueried).to.equal(3);
		expect(report.gateway).to.deep.equal({ '/gateway/brand': 'Buderus' });
		expect(report.unnamedPaths).to.deep.equal(['/gibt/es/nicht']);
		expect(report.valuesWithoutText).to.deep.equal({ '/devices/device1/type': ['XLOW_RF'] });
	});

	it('speichert keine Messwerte', async () => {
		const { adapter, written } = createDiagnosisAdapter(true);
		adapter.recordDiagnosis('/heatSources/hs1/actualPower', { value: 4329, unitOfMeasure: 'W' });
		await adapter.writeDiagnosis();
		expect(written[0].state.val).to.not.include('4329');
	});

	it('vermerkt Pfade ohne Antwort (Verlaufsdaten) nur mit Namen', async () => {
		const { adapter, written } = createDiagnosisAdapter(true);
		adapter.recordDiagnosis('/recordings/gibt/es/nicht');
		await adapter.writeDiagnosis();
		expect(JSON.parse(written[0].state.val).unnamedPaths).to.deep.equal(['/recordings/gibt/es/nicht']);
	});
});

describe('Dateien des Adapters', () => {
	it('package.json und io-package.json haben dieselbe Version', () => {
		expect(ioPackage.common.version).to.equal(packageJson.version);
	});

	it('io-package.json hat für die aktuelle Version eine Neuigkeit in allen Sprachen', () => {
		const news = ioPackage.common.news[packageJson.version];
		expect(news).to.not.equal(undefined);
		expect(Object.keys(news).sort()).to.deep.equal([...LANGUAGES].sort());
	});

	it('alle Namen in lib/names.json gibt es in allen Sprachen', () => {
		for (const section of ['paths', 'templates', 'keys', 'suffixes', 'folders', 'numberedFolders', 'info']) {
			for (const [key, translated] of Object.entries(names[section])) {
				expect(Object.keys(translated).sort(), `${section}: ${key}`).to.deep.equal([...LANGUAGES].sort());
			}
		}
	});

	it('Vorlagen und nummerierte Ordner enthalten den Platzhalter {n}', () => {
		for (const [key, translated] of Object.entries(names.templates)) {
			expect(key, key).to.include('{n}');
			for (const lang of LANGUAGES) {
				expect(translated[lang], `${key} (${lang})`).to.include('{n}');
			}
		}
		for (const [key, translated] of Object.entries(names.numberedFolders)) {
			for (const lang of LANGUAGES) {
				expect(translated[lang], `${key} (${lang})`).to.include('{n}');
			}
		}
	});

	it('alle Texte zu festen Werten sind nicht leer', () => {
		for (const [value, text] of Object.entries(names.stateTexts)) {
			expect(text.trim().length > 0, value).to.equal(true);
		}
	});

	it('alle Übersetzungsdateien der Einstellungen haben dieselben Schlüssel wie en.json', () => {
		const dir = path.join(__dirname, 'admin', 'i18n');
		const english = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'))).sort();
		const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
		expect(files.length).to.equal(LANGUAGES.length);
		for (const file of files) {
			const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))).sort();
			expect(keys, file).to.deep.equal(english);
		}
	});
});
