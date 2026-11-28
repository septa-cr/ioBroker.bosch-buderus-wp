'use strict';

/**
 * Tests for the helper functions and the conversion of the API values in main.js.
 * The tests run without ioBroker and without a device: the adapter core (@iobroker/adapter-core) is replaced by a
 * simple stand-in, no connections are made.
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

/** Stand-in for @iobroker/adapter-core: only what the constructor of the adapter needs */
class FakeAdapter extends EventEmitter {
	constructor() {
		super();
		this.namespace = 'bosch-buderus-wp.0';
		this.common = { version: '9.9.9' };
		this.log = { debug() {}, info() {}, warn() {}, error() {} };
	}
}

/**
 * Loads main.js with the stand-in instead of the real adapter core.
 *
 * @returns {any} What main.js exports (factory for the adapter plus helpers)
 */
function loadMain() {
	const mainPath = require.resolve('./main.js');
	delete require.cache[mainPath];
	// @ts-expect-error _load is not in the types, it is used here on purpose for the stand-in
	const originalLoad = Module._load;
	// @ts-expect-error see above
	Module._load = function (request, ...rest) {
		if (request === '@iobroker/adapter-core') {
			return { Adapter: FakeAdapter };
		}
		return originalLoad.call(this, request, ...rest);
	};
	try {
		return require(mainPath);
	} finally {
		// @ts-expect-error see above
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
		// without a list from the device, the values come from names.json
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

	it('behält bei Zustandslisten mit mehr als zwei Zuständen die Zahl (HeatUpActive: FALSE, HEAT, POSTHEAT)', () => {
		const result = adapter.convertValue({
			type: 'integerValue',
			value: 1,
			state: [{ FALSE: 0, HEAT: 1, POSTHEAT: 2 }],
		});
		expect(result.val).to.equal(1);
		expect(result.type).to.equal('number');
		expect(result.states).to.deep.equal({ 0: 'FALSE', 1: 'HEAT', 2: 'POSTHEAT' });
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

describe('Berechnete Werte (COP)', () => {
	describe('calcCop', () => {
		it('teilt die erzeugte Wärme durch den Stromverbrauch und rundet auf zwei Stellen', () => {
			expect(h.calcCop(17081.34, 4504.81)).to.equal(3.79);
			expect(h.calcCop(3100.74, 989.56)).to.equal(3.13);
		});

		it('liefert null, wenn kein Strom verbraucht wurde oder ein Wert fehlt', () => {
			expect(h.calcCop(10, 0)).to.equal(null);
			expect(h.calcCop(0, 0)).to.equal(null);
			expect(h.calcCop(null, 5)).to.equal(null);
			expect(h.calcCop(5, null)).to.equal(null);
			expect(h.calcCop(undefined, undefined)).to.equal(null);
		});

		it('liefert null bei negativen Wärmemengen, aber 0 bei Wärme 0 mit Stromverbrauch', () => {
			expect(h.calcCop(-1, 5)).to.equal(null);
			expect(h.calcCop(0, 5)).to.equal(0);
		});
	});

	describe('seriesValue', () => {
		const series = [
			{ date: '2026-11-10', value: 12.5 },
			{ date: '2026-11-11', value: null },
		];

		it('findet den Wert zu einem Datum', () => {
			expect(h.seriesValue(series, '2026-11-10')).to.equal(12.5);
		});

		it('liefert null bei fehlendem Datum, fehlendem Wert oder fehlender Reihe', () => {
			expect(h.seriesValue(series, '2026-11-12')).to.equal(null);
			expect(h.seriesValue(series, '2026-11-11')).to.equal(null);
			expect(h.seriesValue(undefined, '2026-11-10')).to.equal(null);
		});
	});

	describe('periodDates', () => {
		it('bestimmt heute, gestern, diesen und den vorigen Monat', () => {
			expect(h.periodDates(new Date(2026, 10, 14, 12))).to.deep.equal({
				today: '2026-11-14',
				yesterday: '2026-11-13',
				thisMonth: '2026-11',
				lastMonth: '2026-10',
			});
		});

		it('kommt mit Monats- und Jahreswechsel zurecht', () => {
			expect(h.periodDates(new Date(2026, 0, 1, 0, 30))).to.deep.equal({
				today: '2026-01-01',
				yesterday: '2025-12-31',
				thisMonth: '2026-01',
				lastMonth: '2025-12',
			});
			expect(h.periodDates(new Date(2026, 2, 1, 8)).yesterday).to.equal('2026-02-28');
		});
	});

	describe('writeEfficiency', () => {
		/**
		 * Adapter with history data and a record of the values written.
		 *
		 * @returns {{ adapter: any, written: Record<string, any>, names: Record<string, any> }} Adapter, values and names written
		 */
		function createCopAdapter() {
			const adapter = createAdapter();
			/** @type {Record<string, any>} */
			const written = {};
			/** @type {Record<string, any>} */
			const writtenNames = {};
			adapter.setValue = async (/** @type {string} */ id, /** @type {any} */ name, /** @type {any} */ val) => {
				written[id] = val;
				writtenNames[id] = name;
			};
			const d = h.periodDates(new Date());
			/**
			 * @param {number} day - Daily value for today and yesterday
			 * @param {number} month - Monthly value for this month and last month
			 * @returns {{ daily: any[], monthly: any[] }} Series
			 */
			const series = (day, month) => ({
				daily: [
					{ date: d.yesterday, value: day },
					{ date: d.today, value: day },
				],
				monthly: [
					{ date: d.lastMonth, value: month },
					{ date: d.thisMonth, value: month },
				],
			});
			const base = '/recordings/heatSources/emon';
			adapter.series.set(`${base}/ch/outputProduced`, series(100, 3000));
			adapter.series.set(`${base}/ch/compressor`, series(25, 600));
			adapter.series.set(`${base}/ch/eheater`, series(0, 0));
			adapter.series.set(`${base}/dhw/outputProduced`, series(12, 300));
			adapter.series.set(`${base}/dhw/compressor`, series(4, 100));
			adapter.series.set(`${base}/dhw/eheater`, series(0, 0));
			adapter.series.set(`${base}/total/outputProduced`, series(112, 3300));
			adapter.series.set(`${base}/total/compressor`, series(29, 700));
			adapter.series.set(`${base}/total/eheater`, series(0, 0));
			adapter.counters.set('heatSources.emon.totalConsumption.outputProduced', 20182.08);
			adapter.counters.set('heatSources.emon.totalConsumption.compressor', 5490.28);
			adapter.counters.set('heatSources.emon.totalConsumption.eheater', 4.11);
			return { adapter, written, names: writtenNames };
		}

		it('schreibt für Heizen, Warmwasser und gesamt je vier Zeiträume', async () => {
			const { adapter, written } = createCopAdapter();
			await adapter.writeEfficiency();
			for (const area of ['heating', 'dhw', 'total']) {
				for (const period of ['today', 'yesterday', 'thisMonth', 'lastMonth']) {
					expect(`calculated.cop.${area}.${period}` in written, `${area}.${period}`).to.equal(true);
				}
			}
			expect(written['calculated.cop.heating.today']).to.equal(4);
			expect(written['calculated.cop.heating.yesterday']).to.equal(4);
			expect(written['calculated.cop.heating.thisMonth']).to.equal(5);
			expect(written['calculated.cop.heating.lastMonth']).to.equal(5);
			expect(written['calculated.cop.dhw.today']).to.equal(3);
			expect(written['calculated.cop.dhw.lastMonth']).to.equal(3);
			expect(written['calculated.cop.total.today']).to.equal(3.86);
		});

		it('schreibt den COP seit Beginn aus den Gesamtzählern (Verdichter plus Heizstab)', async () => {
			const { adapter, written } = createCopAdapter();
			await adapter.writeEfficiency();
			expect(written['calculated.cop.total.sinceStart']).to.equal(3.67);
		});

		it('gibt den Datenpunkten Namen in allen Sprachen', async () => {
			const { adapter, names: writtenNames } = createCopAdapter();
			await adapter.writeEfficiency();
			expect(writtenNames['calculated.cop.heating.today'].de).to.equal('COP Heizen – heute');
			expect(writtenNames['calculated.cop.dhw.lastMonth'].de).to.equal('COP Warmwasser – Vormonat');
			expect(writtenNames['calculated.cop.total.sinceStart'].en).to.equal('COP total – since start');
			expect(Object.keys(writtenNames['calculated.cop.total.yesterday']).sort()).to.deep.equal(
				[...LANGUAGES].sort(),
			);
		});

		it('zeichnet null, wenn in einem Zeitraum kein Strom verbraucht wurde', async () => {
			const { adapter, written } = createCopAdapter();
			const base = '/recordings/heatSources/emon/dhw';
			const d = h.periodDates(new Date());
			adapter.series.set(`${base}/compressor`, { daily: [{ date: d.today, value: 0 }], monthly: [] });
			await adapter.writeEfficiency();
			expect(written['calculated.cop.dhw.today']).to.equal(null);
			expect(written['calculated.cop.dhw.yesterday']).to.equal(null);
		});

		it('legt nichts an, wenn es die Verlaufsdaten bei der Anlage nicht gibt', async () => {
			const adapter = createAdapter();
			/** @type {string[]} */
			const written = [];
			adapter.setValue = async (/** @type {string} */ id) => {
				written.push(id);
			};
			await adapter.writeEfficiency();
			expect(written).to.deep.equal([]);
		});

		it('rechnet ohne Heizstab-Verlauf weiter (Heizstab zählt dann als 0)', async () => {
			const { adapter, written } = createCopAdapter();
			adapter.series.delete('/recordings/heatSources/emon/ch/eheater');
			await adapter.writeEfficiency();
			expect(written['calculated.cop.heating.today']).to.equal(4);
		});
	});
});

describe('Anlagenschema', () => {
	describe('deriveMode', () => {
		it('ordnet die bekannten Status dem Zustand des Schemas zu', () => {
			expect(h.deriveMode('heating')).to.equal('heating');
			expect(h.deriveMode('dhw')).to.equal('dhw');
			expect(h.deriveMode('defrost')).to.equal('defrost');
			expect(h.deriveMode('passive_defrost')).to.equal('passiveDefrost');
			expect(h.deriveMode('pool_heat')).to.equal('pool');
			expect(h.deriveMode('shutoff')).to.equal('idle');
			expect(h.deriveMode('alarm')).to.equal('alarm');
		});

		it('meldet unbekannte und fehlende Werte als unknown', () => {
			expect(h.deriveMode('something_new')).to.equal('unknown');
			expect(h.deriveMode('toString')).to.equal('unknown');
			expect(h.deriveMode(undefined)).to.equal('unknown');
			expect(h.deriveMode(null)).to.equal('unknown');
			expect(h.deriveMode(5)).to.equal('unknown');
		});

		it('kennt alle Werte der Werteliste des Status des Kältekreises', () => {
			for (const status of names.stateValues['/heatSources/hs{n}/refrigerant/status']) {
				expect(h.deriveMode(status), status).to.not.equal('unknown');
			}
		});
	});

	describe('buildSchemaData', () => {
		it('liefert den Zustand und alle Werte, fehlende Werte sind null', () => {
			const latest = new Map();
			latest.set('heatSources.hs1.refrigerant.status', 'dhw');
			latest.set(h.SCHEMA_VALUES.tc0, 57.5);
			latest.set(h.SCHEMA_VALUES.dhwValve, true);
			const data = h.buildSchemaData(latest);
			expect(data.v).to.equal(1);
			expect(data.mode).to.equal('dhw');
			expect(data.status).to.equal('dhw');
			expect(data.values.tc0).to.equal(57.5);
			expect(data.values.dhwValve).to.equal(true);
			expect(data.values.tw1).to.equal(null);
			expect(Object.keys(data.values)).to.deep.equal(Object.keys(h.SCHEMA_VALUES));
		});

		it('meldet ohne Status den Zustand unknown', () => {
			const data = h.buildSchemaData(new Map());
			expect(data.mode).to.equal('unknown');
			expect(data.status).to.equal(null);
		});

		it('erzeugt unabhängig von der Reihenfolge der Eingabe denselben Text', () => {
			const a = new Map([
				['heatSources.hs1.refrigerant.status', 'heating'],
				[h.SCHEMA_VALUES.t1, 5.2],
				[h.SCHEMA_VALUES.tc3, 30],
			]);
			const b = new Map([
				[h.SCHEMA_VALUES.tc3, 30],
				[h.SCHEMA_VALUES.t1, 5.2],
				['heatSources.hs1.refrigerant.status', 'heating'],
			]);
			expect(JSON.stringify(h.buildSchemaData(a))).to.equal(JSON.stringify(h.buildSchemaData(b)));
		});
	});

	describe('Datenpunkt calculated.schema', () => {
		/**
		 * Adapter that records what setValue receives.
		 *
		 * @param {boolean} enabled - Diagram switched on
		 * @returns {{ adapter: any, written: { id: string, name: any, val: any }[] }} Adapter and the values written
		 */
		function createSchemaAdapter(enabled) {
			const adapter = createAdapter();
			/** @type {{ id: string, name: any, val: any }[]} */
			const written = [];
			adapter.schemaEnabled = enabled;
			adapter.setValue = async (/** @type {string} */ id, /** @type {any} */ name, /** @type {any} */ val) => {
				written.push({ id, name, val });
			};
			return { adapter, written };
		}

		it('schreibt nichts, wenn das Schema ausgeschaltet ist', async () => {
			const { adapter, written } = createSchemaAdapter(false);
			await adapter.writeSchema();
			expect(written).to.deep.equal([]);
		});

		it('schreibt die Daten als JSON-Text mit Namen in allen Sprachen', async () => {
			const { adapter, written } = createSchemaAdapter(true);
			adapter.latest.set('heatSources.hs1.refrigerant.status', 'defrost');
			adapter.latest.set(h.SCHEMA_VALUES.tl2, 22);
			await adapter.writeSchema();
			expect(written.length).to.equal(1);
			expect(written[0].id).to.equal('calculated.schema');
			expect(Object.keys(written[0].name).sort()).to.deep.equal([...LANGUAGES].sort());
			const data = JSON.parse(written[0].val);
			expect(data.mode).to.equal('defrost');
			expect(data.values.tl2).to.equal(22);
		});

		it('merkt sich beim Schreiben nur die Werte für das Schema und nur im eingeschalteten Zustand', async () => {
			const adapter = createAdapter();
			adapter.setStateChangedAsync = async () => {};
			adapter.knownStates.add('heatSources.hs1.refrigerant.status');
			adapter.knownStates.add('system.type');

			adapter.schemaEnabled = false;
			await adapter.setValue('heatSources.hs1.refrigerant.status', {}, 'dhw', 'string', 'text');
			expect(adapter.latest.size).to.equal(0);

			adapter.schemaEnabled = true;
			await adapter.setValue('heatSources.hs1.refrigerant.status', {}, 'dhw', 'string', 'text');
			await adapter.setValue('system.type', {}, 'x', 'string', 'text');
			expect(adapter.latest.get('heatSources.hs1.refrigerant.status')).to.equal('dhw');
			expect(adapter.latest.has('system.type')).to.equal(false);
		});
	});
});

describe('Diagnosebericht', () => {
	/**
	 * Adapter that records the states written.
	 *
	 * @param {boolean} enabled - Report switched on
	 * @returns {{ adapter: any, written: { id: string, state: any }[] }} Adapter and the states written
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
		for (const section of [
			'paths',
			'templates',
			'keys',
			'suffixes',
			'folders',
			'numberedFolders',
			'info',
			'calculated',
		]) {
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

	it('das Anlagenschema ist standardmäßig ausgeschaltet und hat einen Schalter im dritten Reiter', () => {
		expect(ioPackage.native.schemaEnabled).to.equal(false);
		const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'admin', 'jsonConfig.json'), 'utf8'));
		expect(Object.keys(config.items).length).to.equal(3);
		expect(config.items._schemaTab.items.schemaEnabled.type).to.equal('checkbox');
	});

	it('die Seite des Anlagenschemas liegt im Ordner www und es gibt keinen Link mit Platzhalter für die Adresse', () => {
		expect(fs.existsSync(path.join(__dirname, 'www', 'index.html'))).to.equal(true);
		// %ip% is replaced by the setting "ip" of the instance (the gateway), so it must not be used
		expect(ioPackage.common.localLinks).to.equal(undefined);
	});

	it('der Ordner www gehört zum veröffentlichten Paket', () => {
		expect(packageJson.files).to.include('www/');
	});
});
