'use strict';

const utils = require('@iobroker/adapter-core');
const https = require('node:https');
const crypto = require('node:crypto');
const endpoints = require('./lib/endpoints.json');
/** @type {{ paths: Record<string, ioBroker.Translated>, templates: Record<string, ioBroker.Translated>, keys: Record<string, ioBroker.Translated>, suffixes: Record<string, ioBroker.Translated>, folders: Record<string, ioBroker.Translated>, numberedFolders: Record<string, ioBroker.Translated>, fields: Record<string, Record<string, string>>, stateValues: Record<string, string[]>, stateTexts: Record<string, string>, info: Record<string, ioBroker.Translated>, calculated: Record<string, ioBroker.Translated> }} */
const names = require('./lib/names.json');

/** Interval after which the search for the available paths is repeated completely (24 hours) */
const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Identifier of the path list: changes when a new version of the adapter file endpoints.json contains different paths */
const ENDPOINTS_SIGNATURE = crypto.createHash('sha1').update(endpoints.join('\n')).digest('hex').slice(0, 12);

/** Paths whose value may appear in the diagnosis report (device properties only, no personal data) */
const DIAGNOSIS_VALUES = new Set([
	'/gateway/brand',
	'/gateway/versionFirmware',
	'/gateway/versionHardware',
	'/system/type',
	'/system/bus',
	'/heatSources/hs1/heatPumpType',
]);

/** Values for which no text can be missing in the diagnosis report (plain on/off values) */
const PLAIN_VALUES = new Set(['on', 'off', 'yes', 'no', 'true', 'false']);

/** Interval at which history data and other rarely changing values are queried (1 hour) */
const SLOW_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Date as YYYY-MM-DD in local time.
 *
 * @param {Date} date - Date
 * @returns {string} Formatted date
 */
function formatDate(date) {
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Rare values: history data and the Wi-Fi list.
 *
 * @param {string} apiPath - API path
 * @returns {boolean} true if the path should only be queried hourly
 */
function isSlowPath(apiPath) {
	return apiPath.startsWith('/recordings/') || apiPath === '/gateway/wifi/apList';
}

/**
 * Convert a unit from the API to the spelling used by ioBroker.
 *
 * @param {string | undefined} unit - Unit from the API
 * @returns {string | undefined} Unit for ioBroker
 */
function normalizeUnit(unit) {
	switch (unit) {
		case 'C':
			return '°C';
		case 'mins':
			return 'min';
		case 'db':
			return 'dB';
		case 'day':
		case 'month':
		case 'year':
			// Parts of a date (e.g. installation date) are not a unit; an empty text removes a previously set unit
			return '';
		default:
			return unit;
	}
}

/**
 * Suitable role for a number value, based on its unit.
 *
 * @param {string | undefined} unit - Unit
 * @param {string} apiPath - API path (used to recognise humidity)
 * @returns {string} Role of the data point
 */
function numberRole(unit, apiPath) {
	switch (unit) {
		case '°C':
			return 'value.temperature';
		case 'kWh':
		case 'Wh':
			return 'value.energy';
		case 'W':
		case 'kW':
			return 'value.power';
		default:
			return unit === '%' && /humidity/i.test(apiPath) ? 'value.humidity' : 'value';
	}
}

/** Patterns for numbered folders, e.g. hc1 = heating circuit 1. The second value is the key in names.numberedFolders */
/** @type {[RegExp, string][]} */
const NUMBERED_FOLDERS = [
	[/^hc(\d+)$/, 'hc'],
	[/^dhw(\d+)$/, 'dhw'],
	[/^hs(\d+)$/, 'hs'],
	[/^device(\d+)$/, 'device'],
	[/^zone(\d+)$/, 'zone'],
	[/^sc(\d+)$/, 'sc'],
	[/^input(\d+)$/, 'input'],
	[/^HP(\d+)$/, 'HP'],
	[/^HC(\d+)$/, 'hc'],
	[/^DHW(\d+)$/, 'dhw'],
];

/**
 * Inserts the number for the placeholder {n} into a translated name, in all languages.
 *
 * @param {ioBroker.Translated} translated - Name with {n}
 * @param {string} number - Number, e.g. "2"
 * @returns {ioBroker.Translated} Name with the number inserted
 */
function fillNumber(translated, number) {
	/** @type {Record<string, string>} */
	const result = {};
	for (const [lang, text] of Object.entries(translated)) {
		result[lang] = text.split('{n}').join(number);
	}
	return /** @type {ioBroker.Translated} */ (result);
}

/**
 * Readable name for a folder in the object tree (the texts are in lib/names.json).
 *
 * @param {string} segment - Part of the data point ID, e.g. heatingCircuits or hc1
 * @returns {ioBroker.StringOrTranslated} Name
 */
function folderName(segment) {
	if (names.folders[segment]) {
		return names.folders[segment];
	}
	for (const [pattern, key] of NUMBERED_FOLDERS) {
		const match = pattern.exec(segment);
		if (match) {
			return fillNumber(names.numberedFolders[key], match[1]);
		}
	}
	return segment;
}

/** Numbered part of an API path, e.g. hc2 in /heatingCircuits/hc2/pumpStatus or HP1 in SRC.CUHP.HP1.Power */
const NUMBER_IN_PATH = /(^|[/.])(hc|dhw|hs|device|zone|sc|input|HP|HC|DHW)(\d+)(?=[/.]|$)/;

/**
 * Name of a data point from the translation file, otherwise the API path.
 * First a fixed entry is looked up, then a template with {n} as placeholder for the number
 * (/heatingCircuits/hc2/pumpStatus becomes /heatingCircuits/hc{n}/pumpStatus with the number 2).
 *
 * @param {string} apiPath - API path
 * @returns {ioBroker.StringOrTranslated} Name
 */
function nameFor(apiPath) {
	const exact = names.paths[apiPath];
	if (exact) {
		return exact;
	}
	const match = NUMBER_IN_PATH.exec(apiPath);
	if (!match) {
		return apiPath;
	}
	const template = names.templates[apiPath.replace(NUMBER_IN_PATH, '$1$2{n}')];
	if (!template) {
		return apiPath;
	}
	return fillNumber(template, match[3]);
}

/**
 * Appends a suffix to a name, e.g. "Total energy – Compressor".
 *
 * @param {ioBroker.StringOrTranslated} base - Base name
 * @param {ioBroker.StringOrTranslated} part - Suffix
 * @returns {ioBroker.StringOrTranslated} Combined name
 */
function withPart(base, part) {
	/** @type {Record<string, string>} */
	const b = typeof base === 'string' ? { en: base } : { ...base };
	/** @type {Record<string, string>} */
	const p = typeof part === 'string' ? { en: part } : { ...part };
	/** @type {Record<string, string>} */
	const result = {};
	for (const lang of new Set([...Object.keys(b), ...Object.keys(p)])) {
		result[lang] = `${b[lang] ?? b.en} – ${p[lang] ?? p.en}`;
	}
	return /** @type {ioBroker.Translated} */ (result);
}

/** Parts of a field path that get no name of their own (they only stand for nesting) */
const SKIPPED_FIELD_PARTS = new Set(['value', 'values']);

/** Languages in which the field names are translated */
const FIELD_LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/**
 * Readable name for a field in a composite response, e.g. values.0.ModuleSerialNumber.
 * Known field names are in lib/names.json, numbers appear in square brackets. If no part is known, the path is kept.
 *
 * @param {string} fieldPath - Path of the field within the response, e.g. progress.cur_step
 * @returns {ioBroker.StringOrTranslated} Name
 */
function fieldName(fieldPath) {
	const parts = fieldPath.split('.').filter(part => !SKIPPED_FIELD_PARTS.has(part));
	if (!parts.some(part => names.fields[part])) {
		return fieldPath;
	}
	/** @type {Record<string, string>} */
	const result = {};
	for (const lang of FIELD_LANGUAGES) {
		result[lang] = parts
			.map(part => {
				if (/^\d+$/.test(part)) {
					return `[${part}]`;
				}
				const translated = names.fields[part];
				return translated ? (translated[lang] ?? translated.en) : part;
			})
			.join(' ');
	}
	return /** @type {ioBroker.Translated} */ (result);
}

/**
 * Key for comparing values: ignoring case, underscores and special characters.
 * Devices report some values spelled differently from the API description (e.g. activeDhw instead of activeDHW).
 *
 * @param {string} value - Value
 * @returns {string} Comparison key
 */
function valueKey(value) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Texts for fixed values, by comparison key (see valueKey) */
/** @type {Map<string, string>} */
const STATE_TEXTS = new Map(Object.entries(names.stateTexts).map(([value, text]) => [valueKey(value), text]));

/**
 * Value list (common.states) for a text data point with fixed values, e.g. the status of the refrigerant circuit.
 * The values come from the list the device itself reports (allowedValues); if it is missing, from the description of the
 * manufacturer API. Values without a known text are left out and then appear unchanged.
 * The texts are single-language because Admin cannot display multi-language value lists.
 * Only paths with fixed values in lib/names.json get a value list (plain on/off values do not).
 *
 * @param {string} apiPath - API path
 * @param {string[]} [deviceValues] - allowed values reported by the device (allowedValues)
 * @returns {Record<string, string> | undefined} Values with texts, or undefined
 */
function statesFor(apiPath, deviceValues) {
	const documented = names.stateValues[apiPath] ?? names.stateValues[apiPath.replace(NUMBER_IN_PATH, '$1$2{n}')];
	if (!documented) {
		return undefined;
	}
	const values = deviceValues?.length ? deviceValues : documented;
	/** @type {Record<string, string>} */
	const states = {};
	for (const value of values) {
		const text = STATE_TEXTS.get(valueKey(value));
		if (text) {
			states[value] = text;
		}
	}
	return Object.keys(states).length > 0 ? states : undefined;
}

/**
 * Build the ID of a data point from an API path.
 *
 * @param {string} apiPath - API path, e.g. /signals/SRC.OutdoorTemp
 * @returns {string} Data point ID
 */
function toId(apiPath) {
	return apiPath
		.replace(/^\//, '')
		.replace(/\//g, '.')
		.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Units for which the API returns the sum of all individual measurements, although the average makes more sense.
 * Energy (kWh), starts and run times, on the other hand, stay sums.
 */
const AVERAGE_UNITS = ['°C', 'K', '%', 'bar'];

/**
 * Converts the series of a history query into a list of dates and values.
 *
 * @param {any} response - API response
 * @param {'P1D' | 'P1M'} rate - Sampling rate (days or months)
 * @param {boolean} average - true: average (sum divided by number of measurements) instead of sum
 * @returns {{ date: string, value: number | null, samples: number }[]} Series of measurements
 */
function extractSeries(response, rate, average) {
	const groups = response?.values ?? [];
	const group = groups.find((/** @type {any} */ entry) => entry.sampleRate === rate) ?? groups[0];
	if (!group || !Array.isArray(group.recording) || typeof group.startTime !== 'string') {
		return [];
	}
	const [year, month, day] = group.startTime.slice(0, 10).split('-').map(Number);
	return group.recording.map((/** @type {{ y: number, c: number }} */ item, /** @type {number} */ index) => {
		const date =
			rate === 'P1D'
				? new Date(Date.UTC(year, month - 1, day + index)).toISOString().slice(0, 10)
				: new Date(Date.UTC(year, month - 1 + index, 1)).toISOString().slice(0, 7);
		/** @type {number | null} */
		let value = item.y;
		if (average) {
			value = item.c > 0 ? Math.round((item.y / item.c) * 10) / 10 : null;
		}
		return { date, value, samples: item.c };
	});
}

/**
 * Coefficient of performance (COP): heat produced divided by the electrical energy used.
 *
 * @param {number | null | undefined} heat - Heat produced in kWh
 * @param {number | null | undefined} electricity - Electrical energy used in kWh
 * @returns {number | null} COP rounded to two decimals, or null if it cannot be calculated (value missing or no energy used)
 */
function calcCop(heat, electricity) {
	if (typeof heat !== 'number' || typeof electricity !== 'number' || !(electricity > 0) || heat < 0) {
		return null;
	}
	return Math.round((heat / electricity) * 100) / 100;
}

/**
 * Value of a history series for one date.
 *
 * @param {{ date: string, value: number | null }[] | undefined} series - Series from extractSeries
 * @param {string} date - Day (YYYY-MM-DD) or month (YYYY-MM)
 * @returns {number | null} Value, or null if the date is not in the series
 */
function seriesValue(series, date) {
	const entry = series?.find(item => item.date === date);
	return typeof entry?.value === 'number' ? entry.value : null;
}

/**
 * Dates of the periods for which the COP is calculated, in local time.
 *
 * @param {Date} now - Current time
 * @returns {{ today: string, yesterday: string, thisMonth: string, lastMonth: string }} Days (YYYY-MM-DD) and months (YYYY-MM)
 */
function periodDates(now) {
	return {
		today: formatDate(now),
		yesterday: formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)),
		thisMonth: formatDate(now).slice(0, 7),
		lastMonth: formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7),
	};
}

/** Areas for which the COP is calculated: ID segment, path segment of the history data and key in names.calculated */
const COP_AREAS = [
	{ id: 'heating', history: 'ch', name: 'copHeating' },
	{ id: 'dhw', history: 'dhw', name: 'copDhw' },
	{ id: 'total', history: 'total', name: 'copTotal' },
];

/** Periods for which the COP is calculated: key (also used for the name and the ID) and kind of history data */
/** @type {{ key: 'today' | 'yesterday' | 'thisMonth' | 'lastMonth', rate: 'daily' | 'monthly' }[]} */
const COP_PERIODS = [
	{ key: 'today', rate: 'daily' },
	{ key: 'yesterday', rate: 'daily' },
	{ key: 'thisMonth', rate: 'monthly' },
	{ key: 'lastMonth', rate: 'monthly' },
];

/** Fields that only contain additional information about the API and are not measured values */
const SKIP_KEYS = new Set(['id', 'type', 'writeable', 'allowedValues', 'uri', 'valueConfig']);

/**
 * Splits a composite response (objects and lists) into single values.
 *
 * @param {any} value - Part of the response
 * @param {string} prefix - Path so far, e.g. values.0
 * @param {[string, string | number | boolean][]} out - Collected values (path, value)
 */
function flatten(value, prefix, out) {
	if (value === null || value === undefined) {
		return;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			// An empty list (e.g. no error messages) gets no data point. Otherwise, when the list later
			// contains entries, data points would be created below a data point. The complete response is in the data point json.
			return;
		}
		if (value.every(item => item === null || typeof item !== 'object')) {
			// Store a list of simple values, e.g. ["ch","dhw"], as text
			out.push([prefix, JSON.stringify(value)]);
			return;
		}
		value.forEach((item, index) => flatten(item, prefix ? `${prefix}.${index}` : String(index), out));
		return;
	}
	if (typeof value === 'object') {
		for (const [key, item] of Object.entries(value)) {
			if (SKIP_KEYS.has(key)) {
				continue;
			}
			const safeKey = key.replace(/[^A-Za-z0-9_-]/g, '_');
			flatten(item, prefix ? `${prefix}.${safeKey}` : safeKey, out);
		}
		return;
	}
	out.push([prefix, value]);
}

/**
 * Allowed values of a data point, as reported by the device.
 *
 * @param {any} data - Response object of the API
 * @returns {string[] | undefined} List of values, or undefined
 */
function allowedValues(data) {
	return Array.isArray(data?.allowedValues) ? data.allowedValues.map(String) : undefined;
}

class BoschBuderusWp extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'bosch-buderus-wp',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));

		/** @type {Set<string>} */
		this.knownStates = new Set();
		/** Folders and channels that have already been created */
		/** @type {Set<string>} */
		this.knownObjects = new Set();
		/** Data points that are split into single values (old text data points have been removed) */
		/** @type {Set<string>} */
		this.expandedStates = new Set();
		/** Data points with user settings (common.custom) that must not be deleted */
		/** @type {Set<string>} */
		this.protectedStates = new Set();
		/** Is the diagnosis report switched on in the settings? */
		this.diagnosisEnabled = false;
		/** Information for the diagnosis report per queried path (without measured values) */
		/** @type {Map<string, { named: boolean, value?: string, missingTexts?: string[] }>} */
		this.diagnosis = new Map();
		/** Single values written last, per composite response */
		/** @type {Map<string, Set<string>>} */
		this.complexLeaves = new Map();
		/** Latest history series per path (for the calculated COP values) */
		/** @type {Map<string, { daily: { date: string, value: number | null }[], monthly: { date: string, value: number | null }[] }>} */
		this.series = new Map();
		/** Latest energy counters per data point ID (for the calculated COP value since start) */
		/** @type {Map<string, number>} */
		this.counters = new Map();
		/** Paths that did not answer during the search and are retried hourly */
		/** @type {string[]} */
		this.retryPaths = [];
		/** @type {ioBroker.Timeout | undefined} */
		this.pollTimer = undefined;
		/** Fixed paths that exist on this system and are queried in every cycle */
		/** @type {string[]} */
		this.fixedPaths = [];
		/** Paths that exist and are only queried hourly (history data, Wi-Fi list) */
		/** @type {string[]} */
		this.slowPaths = [];
		this.lastSlowPoll = 0;
		/** Time of the last complete search for the available paths */
		this.lastDiscovery = 0;
		/** Was a new search requested in the settings? */
		this.rescanRequested = false;
		/** Has the search for the fixed paths been completed? */
		this.discovered = false;
		/** @type {boolean | undefined} */
		this.connected = undefined;
		this.unloaded = false;
	}

	/**
	 * Queries a path of the gateway API.
	 * Returns the response object, or null for a path that does not exist (404) or an unsupported request (400).
	 *
	 * @param {string} path - Path, e.g. /gateway/brand
	 * @returns {Promise<any>} Response object or null
	 */
	apiGet(path) {
		return new Promise((resolve, reject) => {
			const req = https.request(
				{
					host: this.config.ip,
					port: 9443,
					path,
					method: 'GET',
					headers: { Authorization: `Bearer ${this.config.token}` },
					rejectUnauthorized: false, // The device uses a self-signed certificate
					timeout: 10000,
				},
				res => {
					let body = '';
					res.on('data', chunk => (body += chunk));
					res.on('end', () => {
						if (res.statusCode === 404 || res.statusCode === 400) {
							resolve(null);
							return;
						}
						if (res.statusCode !== 200) {
							reject(new Error(`HTTP ${res.statusCode} bei ${path}`));
							return;
						}
						try {
							resolve(JSON.parse(body));
						} catch {
							reject(new Error(`Invalid response for ${path}`));
						}
					});
				},
			);
			req.on('timeout', () => req.destroy(new Error(`Timeout for ${path}`)));
			req.on('error', reject);
			req.end();
		});
	}

	/**
	 * Converts an API response into a value and data type for ioBroker.
	 *
	 * @param {any} data - Response object of the API
	 * @returns {{ val: string | number | boolean | null, type: 'string' | 'number' | 'boolean', unit?: string, states?: Record<string, string> }} Value, type, unit and, if present, state texts
	 */
	convertValue(data) {
		const raw = data.value;
		const unit = normalizeUnit(data.unitOfMeasure);

		if (data.type === 'floatValue' || data.type === 'integerValue') {
			// The API returns the list "state" either as a list of objects or as a single object.
			const entries = (Array.isArray(data.state) ? data.state : [data.state]).filter(
				(/** @type {any} */ entry) => entry && typeof entry === 'object',
			);
			if (data.unitOfMeasure) {
				// Measured value (has a unit): special values (short circuit, wire break, flow too low ...)
				// are not taken over as a measured value.
				const specialValues = entries.flatMap((/** @type {any} */ entry) => Object.values(entry));
				const isSpecial = raw !== undefined && specialValues.includes(raw);
				return { val: isSpecial ? null : raw, type: 'number', unit };
			}
			// Number without unit with a "state" list: state list (e.g. 6 = Not_Commissioned). The value is kept,
			// the texts are stored as a value list on the data point.
			/** @type {Record<string, string>} */
			const states = {};
			for (const entry of entries) {
				for (const [label, code] of Object.entries(entry)) {
					if (typeof code === 'number') {
						states[String(code)] = label;
					}
				}
			}
			return { val: raw, type: 'number', unit, ...(Object.keys(states).length ? { states } : {}) };
		}
		if (raw === 'true' || raw === 'false') {
			return { val: raw === 'true', type: 'boolean' };
		}
		if (raw === undefined || raw === null) {
			// Store responses without a simple value (e.g. lists) as JSON text
			const rest = { ...data };
			delete rest.id;
			delete rest.writeable;
			return { val: JSON.stringify(rest), type: 'string' };
		}
		if (typeof raw === 'object') {
			return { val: JSON.stringify(raw), type: 'string' };
		}
		return { val: String(raw), type: 'string' };
	}

	/**
	 * Creates a data point if needed and writes the value.
	 *
	 * @param {string} id - Data point ID
	 * @param {ioBroker.StringOrTranslated} name - Display name (German and English)
	 * @param {string | number | boolean | null} val - Value
	 * @param {'string' | 'number' | 'boolean'} type - Data type
	 * @param {string} role - Role of the data point
	 * @param {string} [unit] - Unit
	 * @param {Record<string, string>} [states] - Value list with texts (for text data points and numbers without unit)
	 */
	async setValue(id, name, val, type, role, unit, states) {
		if (!this.knownStates.has(id)) {
			if (!(await this.ensureParents(id))) {
				return;
			}
			await this.extendObjectAsync(id, {
				type: 'state',
				common: {
					name,
					type,
					role,
					read: true,
					write: false,
					...(unit !== undefined ? { unit } : {}),
					...(states ? { states } : {}),
				},
				native: {},
			});
			this.knownStates.add(id);
		}
		// Only write when the value has changed (less load and fewer events for logging adapters)
		await this.setStateChangedAsync(id, { val, ack: true });
	}

	/**
	 * Removes an existing data point so that a folder or channel can be created at this place.
	 * If the data point has user settings (common.custom, e.g. for logging), it is not deleted.
	 *
	 * @param {string} id - ID of the object
	 * @returns {Promise<boolean>} true if the ID is free; false if a protected data point remains
	 */
	async removeLegacyState(id) {
		if (this.protectedStates.has(id)) {
			return false;
		}
		const existing = await this.getObjectAsync(id);
		if (!existing || existing.type !== 'state') {
			return true;
		}
		if (existing.common?.custom && Object.keys(existing.common.custom).length > 0) {
			this.protectedStates.add(id);
			this.log.warn(
				`State ${id} has custom settings and is not deleted, so no sub-states can be created below it. Please remove the custom settings and delete the state manually.`,
			);
			return false;
		}
		await this.delObjectAsync(id);
		this.knownStates.delete(id);
		return true;
	}

	/**
	 * Creates missing folders above an object. According to the ioBroker rules, substructures
	 * should consist of objects of type folder, channel or device, and data points should only be on the last level.
	 *
	 * @param {string} id - ID of the data point or channel
	 * @returns {Promise<boolean>} false if a protected data point is in the way and nothing was created
	 */
	async ensureParents(id) {
		const parts = id.split('.');
		for (let i = 1; i < parts.length; i++) {
			const parentId = parts.slice(0, i).join('.');
			if (this.knownObjects.has(parentId)) {
				continue;
			}
			// A data point must not have sub-objects: an existing data point at this place is removed
			if (!(await this.removeLegacyState(parentId))) {
				return false;
			}
			await this.extendObjectAsync(parentId, {
				type: 'folder',
				common: { name: folderName(parts[i - 1]) },
				native: {},
			});
			this.knownObjects.add(parentId);
		}
		return true;
	}

	/**
	 * Creates a channel that groups several values of an API response (e.g. energy counters, history data).
	 *
	 * @param {string} id - ID of the channel
	 * @param {ioBroker.StringOrTranslated} name - Name of the channel
	 */
	async ensureChannel(id, name) {
		if (this.knownObjects.has(id) || this.protectedStates.has(id)) {
			return;
		}
		if (!(await this.ensureParents(id))) {
			return;
		}
		await this.extendObjectAsync(id, { type: 'channel', common: { name }, native: {} });
		this.knownObjects.add(id);
	}

	/**
	 * Writes an API response to the matching data point.
	 *
	 * @param {string} apiPath - API-Pfad, z. B. /signals/SRC.OutdoorTemp
	 * @param {any} data - Response object of the API
	 */
	async writeState(apiPath, data) {
		if (data.type === 'emonValue' && Array.isArray(data.values)) {
			await this.writeEnergyCounters(apiPath, data);
			return;
		}
		const raw = data.value;
		const isNumberType = data.type === 'floatValue' || data.type === 'integerValue';
		if (!isNumberType && (raw === undefined || raw === null || typeof raw === 'object')) {
			await this.writeComplex(apiPath, data);
			return;
		}
		const { val, type, unit, states } = this.convertValue(data);
		const role = type === 'boolean' ? 'indicator' : type === 'number' ? numberRole(unit, apiPath) : 'text';
		await this.setValue(
			toId(apiPath),
			nameFor(apiPath),
			val,
			type,
			role,
			unit,
			type === 'string' ? statesFor(apiPath, allowedValues(data)) : states,
		);
	}

	/**
	 * Split energy counters (e.g. total consumption) into single data points.
	 *
	 * @param {string} apiPath - API-Pfad, z. B. /heatSources/emon/totalConsumption
	 * @param {any} data - Response object of the API
	 */
	async writeEnergyCounters(apiPath, data) {
		const base = toId(apiPath);
		await this.replaceLegacyState(base);
		await this.ensureChannel(base, nameFor(apiPath));
		const unit = normalizeUnit(data.unit);
		const role = numberRole(unit, apiPath);
		for (const entry of data.values) {
			for (const [key, value] of Object.entries(entry ?? {})) {
				const counterId = `${base}.${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
				const name = withPart(nameFor(apiPath), names.keys[key] ?? key);
				this.counters.set(counterId, Number(value));
				await this.setValue(counterId, name, Number(value), 'number', role, unit);
			}
		}
	}

	/**
	 * Removes a text data point from earlier versions once, so that single values can be created below it.
	 *
	 * @param {string} base - Data point ID
	 */
	async replaceLegacyState(base) {
		if (this.expandedStates.has(base)) {
			return;
		}
		this.expandedStates.add(base);
		await this.removeLegacyState(base);
	}

	/**
	 * Split composite responses (e.g. error messages, system info) into single data points.
	 * In addition, the complete response is stored as JSON text.
	 *
	 * @param {string} apiPath - API-Pfad, z. B. /system/basicInfo
	 * @param {any} data - Response object of the API
	 */
	async writeComplex(apiPath, data) {
		const base = toId(apiPath);
		await this.replaceLegacyState(base);

		const content = { ...data };
		delete content.id;
		delete content.writeable;
		delete content.type;
		const baseName = nameFor(apiPath);
		await this.ensureChannel(base, baseName);
		const jsonName = withPart(baseName, names.suffixes.json);
		await this.setValue(`${base}.json`, jsonName, JSON.stringify(content), 'string', 'json');

		/** @type {[string, string | number | boolean][]} */
		const leaves = [];
		flatten(content, '', leaves);
		const current = new Set();
		for (const [path, value] of leaves) {
			const id = `${base}.${path}`;
			const name = withPart(baseName, fieldName(path));
			current.add(id);
			if (value === 'true' || value === 'false' || typeof value === 'boolean') {
				await this.setValue(id, name, value === true || value === 'true', 'boolean', 'indicator');
			} else if (typeof value === 'number') {
				await this.setValue(id, name, value, 'number', 'value');
			} else {
				await this.setValue(id, name, String(value), 'string', 'text');
			}
		}
		// Clear values that no longer appear in the response (e.g. resolved error messages)
		for (const id of this.complexLeaves.get(base) ?? []) {
			if (!current.has(id)) {
				await this.setStateChangedAsync(id, { val: null, ack: true });
			}
		}
		this.complexLeaves.set(base, current);
	}

	/**
	 * Queries history data (daily values of the last 31 days, monthly values of the last 12 months)
	 * and writes them to data points. Temperatures as average, energy, starts and run times as sum.
	 *
	 * @param {string} apiPath - Path, e.g. /recordings/heatSources/emon/total/compressor
	 * @returns {Promise<boolean>} true if this history data exists on the system
	 */
	async pollRecording(apiPath) {
		const now = new Date();
		const dayStart = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30));
		const monthStart = formatDate(new Date(now.getFullYear(), now.getMonth() - 11, 1));

		const daily = await this.apiGet(`${apiPath}?sampleRate=P1D&startDate=${dayStart}`);
		const monthly = await this.apiGet(`${apiPath}?sampleRate=P1M&startDate=${monthStart}`);
		if (!daily && !monthly) {
			return false;
		}

		const unit = normalizeUnit((daily ?? monthly).unitOfMeasure);
		const average = AVERAGE_UNITS.includes(unit ?? '');
		const dailySeries = extractSeries(daily, 'P1D', average);
		const monthlySeries = extractSeries(monthly, 'P1M', average);
		this.series.set(apiPath, { daily: dailySeries, monthly: monthlySeries });
		const lastDay = dailySeries[dailySeries.length - 1];
		const lastMonth = monthlySeries[monthlySeries.length - 1];
		const today = formatDate(now);

		const base = toId(apiPath);
		const baseName = nameFor(apiPath);
		const role = numberRole(unit, apiPath);
		await this.ensureChannel(base, baseName);
		if (daily) {
			await this.setValue(
				`${base}.daily`,
				withPart(baseName, names.suffixes.daily),
				JSON.stringify(dailySeries),
				'string',
				'json',
			);
			await this.setValue(
				`${base}.today`,
				withPart(baseName, names.suffixes.today),
				lastDay?.date === today ? lastDay.value : null,
				'number',
				role,
				unit,
			);
		}
		if (monthly) {
			await this.setValue(
				`${base}.monthly`,
				withPart(baseName, names.suffixes.monthly),
				JSON.stringify(monthlySeries),
				'string',
				'json',
			);
			await this.setValue(
				`${base}.thisMonth`,
				withPart(baseName, names.suffixes.thisMonth),
				lastMonth?.date === today.slice(0, 7) ? lastMonth.value : null,
				'number',
				role,
				unit,
			);
		}
		return true;
	}

	/**
	 * Calculates the coefficient of performance (COP) from the history data and the energy counters of the device:
	 * heat produced divided by the electricity used by the compressor and the electric heater.
	 * The values are written below calculated.cop for heating, hot water and in total.
	 */
	async writeEfficiency() {
		const dates = periodDates(new Date());
		for (const area of COP_AREAS) {
			const prefix = `/recordings/heatSources/emon/${area.history}`;
			const heat = this.series.get(`${prefix}/outputProduced`);
			const compressor = this.series.get(`${prefix}/compressor`);
			const eheater = this.series.get(`${prefix}/eheater`);
			if (!heat || !compressor) {
				// This history data does not exist on this system
				continue;
			}
			for (const period of COP_PERIODS) {
				const date = dates[period.key];
				const compressorValue = seriesValue(compressor[period.rate], date);
				const electricity =
					compressorValue === null
						? null
						: compressorValue + (seriesValue(eheater?.[period.rate], date) ?? 0);
				await this.setValue(
					`calculated.cop.${area.id}.${period.key}`,
					withPart(names.calculated[area.name], names.suffixes[period.key]),
					calcCop(seriesValue(heat[period.rate], date), electricity),
					'number',
					'value',
				);
			}
		}

		const counter = 'heatSources.emon.totalConsumption';
		const heatCounter = this.counters.get(`${counter}.outputProduced`);
		const compressorCounter = this.counters.get(`${counter}.compressor`);
		if (heatCounter !== undefined && compressorCounter !== undefined) {
			await this.setValue(
				'calculated.cop.total.sinceStart',
				withPart(names.calculated.copTotal, names.suffixes.sinceStart),
				calcCop(heatCounter, compressorCounter + (this.counters.get(`${counter}.eheater`) ?? 0)),
				'number',
				'value',
			);
		}
	}

	/**
	 * Remembers for the diagnosis report whether a path has a name and whether texts exist for its fixed values.
	 * Measured values are not stored, only single device properties (see DIAGNOSIS_VALUES).
	 *
	 * @param {string} apiPath - API path
	 * @param {any} [data] - Response object of the API (not present for history data)
	 */
	recordDiagnosis(apiPath, data) {
		if (!this.diagnosisEnabled) {
			return;
		}
		/** @type {{ named: boolean, value?: string, missingTexts?: string[] }} */
		const entry = { named: nameFor(apiPath) !== apiPath };
		if (data && DIAGNOSIS_VALUES.has(apiPath) && typeof data.value === 'string') {
			entry.value = data.value;
		}
		const deviceValues = allowedValues(data);
		if (deviceValues) {
			const known = statesFor(apiPath, deviceValues) ?? {};
			const missing = deviceValues.filter(
				(/** @type {string} */ v) => v !== '' && !PLAIN_VALUES.has(v) && !(v in known),
			);
			if (missing.length) {
				entry.missingTexts = missing;
			}
		}
		this.diagnosis.set(apiPath, entry);
	}

	/**
	 * Writes the diagnosis report (data point info.diagnosis). It contains no measured values and no personal data:
	 * version, single device properties, paths without names and fixed values without text.
	 * Testers can paste it into the forum so that missing names and texts can be added.
	 */
	async writeDiagnosis() {
		if (!this.diagnosisEnabled) {
			return;
		}
		/** @type {Record<string, string>} */
		const gateway = {};
		/** @type {string[]} */
		const unnamedPaths = [];
		/** @type {Record<string, string[]>} */
		const valuesWithoutText = {};
		for (const [apiPath, entry] of [...this.diagnosis].sort(([a], [b]) => a.localeCompare(b))) {
			if (entry.value !== undefined) {
				gateway[apiPath] = entry.value;
			}
			if (!entry.named) {
				unnamedPaths.push(apiPath);
			}
			if (entry.missingTexts) {
				valuesWithoutText[apiPath] = entry.missingTexts;
			}
		}
		const report = {
			adapter: this.common?.version ?? 'unknown',
			pathsQueried: this.diagnosis.size,
			gateway,
			unnamedPaths,
			valuesWithoutText,
		};
		await this.setStateChangedAsync('info.diagnosis', { val: JSON.stringify(report, null, 1), ack: true });
	}

	/**
	 * Queries a path and writes the value to the data point.
	 *
	 * @param {string} apiPath - API path
	 * @returns {Promise<boolean>} true if the path exists on the system
	 */
	async pollOne(apiPath) {
		if (apiPath.startsWith('/recordings/')) {
			const exists = await this.pollRecording(apiPath);
			if (exists) {
				this.recordDiagnosis(apiPath);
			}
			return exists;
		}
		const data = await this.apiGet(apiPath);
		if (!data) {
			return false;
		}
		await this.writeState(apiPath, data);
		this.recordDiagnosis(apiPath, data);
		return true;
	}

	/**
	 * Sets the connection indicator (info.connection), but only on a change.
	 *
	 * @param {boolean} connected - true if the gateway responds
	 */
	async setConnected(connected) {
		if (this.connected === connected) {
			return;
		}
		this.connected = connected;
		await this.setState('info.connection', { val: connected, ack: true });
	}

	/**
	 * Short pause between two queries. When the adapter is shutting down, no new timer is started.
	 *
	 * @param {number} ms - Duration in milliseconds
	 * @returns {Promise<void>}
	 */
	pause(ms) {
		if (this.unloaded) {
			return Promise.resolve();
		}
		return new Promise(resolve => {
			this.setTimeout(() => resolve(), ms);
		});
	}

	/**
	 * Queries a list of paths and writes the values to the data points.
	 *
	 * @param {string[]} paths - API paths
	 */
	async pollPaths(paths) {
		for (const apiPath of paths) {
			if (this.unloaded) {
				return;
			}
			try {
				await this.pollOne(apiPath);
			} catch (error) {
				this.log.debug(`${apiPath}: ${error.message}`);
			}
			await this.pause(50);
		}
	}

	/**
	 * Tries all fixed paths from endpoints.json once and remembers those
	 * that exist on this system (all others answer with 404).
	 * Aborts if the device does not answer several times in a row.
	 */
	async discoverFixedPaths() {
		const fast = [];
		const slow = [];
		const failed = [];
		let notPresent = 0;
		let errors = 0;
		for (const apiPath of endpoints) {
			if (this.unloaded) {
				return;
			}
			try {
				const exists = await this.pollOne(apiPath);
				errors = 0;
				if (exists) {
					(isSlowPath(apiPath) ? slow : fast).push(apiPath);
				} else {
					notPresent++;
				}
			} catch (error) {
				this.log.debug(`${apiPath}: ${error.message}`);
				failed.push(apiPath);
				errors++;
				if (errors >= 5) {
					this.log.warn('Search for fixed paths aborted, the device does not respond. Will try again.');
					return;
				}
			}
			await this.pause(20);
		}
		this.fixedPaths = fast;
		this.slowPaths = slow;
		this.retryPaths = failed;
		this.lastSlowPoll = Date.now();
		this.lastDiscovery = Date.now();
		this.discovered = true;
		await this.saveDiscovery();
		this.log.info(
			`Search finished: ${endpoints.length} paths checked, ${fast.length + slow.length} present ` +
				`(${slow.length} of them hourly), ${notPresent} not present on this system, ` +
				`${failed.length} without response`,
		);
		if (failed.length) {
			this.log.info(`No response (retried hourly): ${failed.join(', ')}`);
		}
	}

	/**
	 * Retries paths that did not answer during the search.
	 * Existing ones are added to the normal query, non-existing ones are sorted out.
	 */
	async retryFailedPaths() {
		const stillFailing = [];
		for (const apiPath of this.retryPaths) {
			if (this.unloaded) {
				return;
			}
			try {
				if (await this.pollOne(apiPath)) {
					(isSlowPath(apiPath) ? this.slowPaths : this.fixedPaths).push(apiPath);
					this.log.info(`Path found later: ${apiPath}`);
				}
			} catch (error) {
				this.log.debug(`${apiPath}: ${error.message}`);
				stillFailing.push(apiPath);
			}
			await this.pause(50);
		}
		this.retryPaths = stillFailing;
	}

	/**
	 * Stores the paths found, so that the next start can work with this list right away.
	 */
	async saveDiscovery() {
		const data = {
			v: 1,
			signature: ENDPOINTS_SIGNATURE,
			ip: this.config.ip,
			ts: this.lastDiscovery,
			fixed: this.fixedPaths,
			slow: this.slowPaths,
			retry: this.retryPaths,
		};
		await this.setStateChangedAsync('info.discoveredPaths', { val: JSON.stringify(data), ack: true });
	}

	/**
	 * Loads the stored list of the paths found.
	 * It is only used if it matches the current path list and the configured IP address.
	 *
	 * @returns {Promise<boolean>} true if a valid list was loaded
	 */
	async loadDiscovery() {
		const state = await this.getStateAsync('info.discoveredPaths');
		if (!state || typeof state.val !== 'string') {
			return false;
		}
		try {
			const data = JSON.parse(state.val);
			const known = new Set(endpoints);
			const isValid = (/** @type {unknown} */ list) =>
				Array.isArray(list) && list.every(item => typeof item === 'string' && known.has(item));
			if (
				data.v !== 1 ||
				data.signature !== ENDPOINTS_SIGNATURE ||
				data.ip !== this.config.ip ||
				!isValid(data.fixed) ||
				!isValid(data.slow) ||
				!isValid(data.retry) ||
				data.fixed.length + data.slow.length === 0
			) {
				return false;
			}
			this.fixedPaths = data.fixed;
			this.slowPaths = data.slow;
			this.retryPaths = data.retry;
			this.lastDiscovery = Number(data.ts) || 0;
			this.discovered = true;
			this.log.info(
				`Saved path list loaded: ${data.fixed.length + data.slow.length} present ` +
					`(${data.slow.length} of them hourly), the search is not repeated`,
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Sends form data to the gateway via POST (e.g. to request the API token).
	 *
	 * @param {string} host - IP address of the gateway
	 * @param {number} port - Port
	 * @param {string} path - Path
	 * @param {string} body - Form data (application/x-www-form-urlencoded)
	 * @returns {Promise<any>} Response as object
	 */
	postForm(host, port, path, body) {
		return new Promise((resolve, reject) => {
			const req = https.request(
				{
					host,
					port,
					path,
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						'Content-Length': Buffer.byteLength(body),
					},
					rejectUnauthorized: false, // The device uses a self-signed certificate
					timeout: 15000,
				},
				res => {
					let text = '';
					res.on('data', chunk => (text += chunk));
					res.on('end', () => {
						if (res.statusCode !== 200) {
							let reason = '';
							try {
								const body = JSON.parse(text);
								reason = typeof body.error === 'string' ? ` (${body.error})` : '';
							} catch {
								// no usable response
							}
							const error = /** @type {Error & { statusCode?: number }} */ (
								new Error(`HTTP ${res.statusCode}${reason}`)
							);
							error.statusCode = res.statusCode;
							reject(error);
							return;
						}
						try {
							resolve(JSON.parse(text));
						} catch {
							reject(new Error('Invalid response'));
						}
					});
				},
			);
			req.on('timeout', () => req.destroy(new Error('Timeout')));
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	/**
	 * Requests an API token from the gateway (login and pass from the sticker on the device).
	 * Login and pass are neither stored nor logged.
	 *
	 * @param {any} message - Data from the settings (ip, login, pass)
	 * @returns {Promise<{ error?: string, result?: string, native?: { token: string } }>} Response to the settings page
	 */
	async requestToken(message) {
		const ip = typeof message?.ip === 'string' ? message.ip.trim() : '';
		const login = typeof message?.login === 'string' ? message.login.trim() : '';
		// According to the manufacturer, the hyphens must be removed from the value "Pass"
		const pass = typeof message?.pass === 'string' ? message.pass.replace(/-/g, '').trim() : '';
		if (!ip || !login || !pass) {
			return { error: 'Please enter the IP address, Login and Pass.' };
		}
		if (!/^[A-Za-z0-9.-]+$/.test(ip)) {
			return { error: 'The IP address is not valid.' };
		}
		try {
			const body = new URLSearchParams({
				grant_type: 'password',
				username: login,
				password: pass,
				client_name: 'iobroker',
			}).toString();
			const data = await this.postForm(ip, 9442, '/auth/token', body);
			if (typeof data?.access_token !== 'string' || !data.access_token) {
				return { error: 'The gateway did not return an API token.' };
			}
			this.log.info('API token received from the gateway');
			return { result: 'API token received. Please save the settings.', native: { token: data.access_token } };
		} catch (error) {
			const statusCode = /** @type {{ statusCode?: number }} */ (error).statusCode;
			this.log.warn(`Token request failed: ${error.message}`);
			if (statusCode === 412) {
				// physical_proximity_unproven: the buttons on the device were not pressed (in time)
				return {
					error:
						'Please press the WLAN and Wireless buttons on the gateway at the same time for one second ' +
						'and request the token again within 5 minutes.',
				};
			}
			if (statusCode === 400) {
				// invalid_grant: login or pass are wrong
				return {
					error:
						'The gateway refused the login data. Check Login and Pass, ' +
						'and press the WLAN and Wireless buttons on the gateway first.',
				};
			}
			if (statusCode === 507) {
				// Token database full
				return {
					error:
						'The gateway cannot store another API token. ' +
						"A token can only be revoked with the token itself (see the manufacturer's guide).",
				};
			}
			if (statusCode) {
				return { error: 'The gateway refused the request.' };
			}
			return { error: 'The gateway could not be reached.' };
		}
	}

	/**
	 * Messages from the settings page (buttons).
	 *
	 * @param {ioBroker.Message} obj - Message
	 */
	async onMessage(obj) {
		if (!obj || typeof obj !== 'object' || typeof obj.command !== 'string') {
			return;
		}
		let response;
		if (obj.command === 'getToken') {
			response = await this.requestToken(obj.message);
		} else if (obj.command === 'rescan') {
			this.rescanRequested = true;
			response = { result: 'The search for resources will start with the next query cycle.' };
		} else {
			return;
		}
		if (obj.callback) {
			this.sendTo(obj.from, obj.command, response, obj.callback);
		}
	}

	/**
	 * One polling cycle: get the signal list, read all values and schedule the next cycle.
	 */
	async pollCycle() {
		try {
			const signals = await this.apiGet('/signals');
			if (!signals) {
				throw new Error('Signal list not available');
			}
			const ids = (signals.references ?? []).map((/** @type {{ id: string }} */ ref) => ref.id);
			if (this.connected === false) {
				this.log.info('Connection to the gateway established');
			}
			await this.setConnected(true);

			let fixed = this.fixedPaths;
			let slow = /** @type {string[]} */ ([]);
			const rescanDue =
				this.discovered && (this.rescanRequested || Date.now() - this.lastDiscovery >= RESCAN_INTERVAL_MS);
			if (!this.discovered || rescanDue) {
				// Without a stored list, once a day and on request, the available paths are searched
				this.rescanRequested = false;
				await this.discoverFixedPaths();
				fixed = [];
			} else if (Date.now() - this.lastSlowPoll >= SLOW_INTERVAL_MS) {
				slow = this.slowPaths;
				this.lastSlowPoll = Date.now();
				if (this.retryPaths.length) {
					await this.retryFailedPaths();
				}
			}
			await this.pollPaths([...ids, ...fixed, ...slow]);
			try {
				await this.writeEfficiency();
			} catch (error) {
				this.log.debug(`COP calculation failed: ${error.message}`);
			}
			await this.writeDiagnosis();
			this.log.debug(`${ids.length + fixed.length + slow.length} values updated`);
		} catch (error) {
			if (this.connected !== false) {
				this.log.warn(`Connection to the gateway lost: ${error.message}`);
			} else {
				this.log.debug(`Query failed: ${error.message}`);
			}
			await this.setConnected(false);
		}
		if (this.unloaded) {
			return;
		}
		// The interval is also limited in the code (10 to 3600 seconds), not only in the settings
		const seconds = Math.min(3600, Math.max(10, Number(this.config.interval) || 60));
		this.pollTimer = this.setTimeout(() => this.pollCycle(), seconds * 1000);
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.extendObjectAsync('info', {
			type: 'channel',
			common: { name: names.info.channel },
			native: {},
		});
		await this.extendObjectAsync('info.connection', {
			type: 'state',
			common: {
				name: names.info.connection,
				type: 'boolean',
				role: 'indicator.connected',
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});
		await this.extendObjectAsync('info.discoveredPaths', {
			type: 'state',
			common: {
				name: names.info.discoveredPaths,
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
			native: {},
		});
		// Diagnosis report: only create the data point if it is switched on in the settings, otherwise remove it
		this.diagnosisEnabled = this.config.diagnosis === true;
		if (this.diagnosisEnabled) {
			await this.extendObjectAsync('info.diagnosis', {
				type: 'state',
				common: {
					name: names.info.diagnosis,
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			});
		} else if (await this.getObjectAsync('info.diagnosis')) {
			await this.delObjectAsync('info.diagnosis');
		}
		await this.setConnected(false);

		if (!this.config.ip || !this.config.token) {
			this.log.error('Please enter the IP address and token in the adapter settings.');
			return;
		}

		try {
			const brand = await this.apiGet('/gateway/brand');
			this.log.info(`Connection successful, manufacturer: ${brand?.value}`);
		} catch (error) {
			this.log.error(`Connection to the gateway failed: ${error.message}`);
		}

		// Load the stored path list so that the search for the available paths does not run on every start
		await this.loadDiscovery();

		// Starts the regular polling. If a cycle fails, it is retried automatically.
		await this.pollCycle();
		this.log.info(`${this.knownStates.size} data points created, polling runs at the configured interval`);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		try {
			this.unloaded = true;
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
				this.pollTimer = undefined;
			}
			void this.setState('info.connection', { val: false, ack: true });
		} finally {
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	const createAdapter = options => new BoschBuderusWp(options);
	// The helper functions are also exported so that the tests (main.test.js) can check them individually
	module.exports = Object.assign(createAdapter, {
		helpers: {
			formatDate,
			isSlowPath,
			normalizeUnit,
			numberRole,
			nameFor,
			folderName,
			fieldName,
			valueKey,
			statesFor,
			toId,
			extractSeries,
			calcCop,
			seriesValue,
			periodDates,
			flatten,
			allowedValues,
		},
	});
} else {
	// otherwise start the instance directly
	new BoschBuderusWp();
}
