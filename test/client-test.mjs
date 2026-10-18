/**
 * 客户端 bundle 离线测试：
 * 在假浏览器环境里 materialize lib/client.js，断言注册形状与组件可渲染。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const modules = new Map();
const fakeWindow = {
	__ModuleLoader__: {
		load(definition) {
			modules.set(definition.id, definition);
		}
	}
};
const fakeDocument = {
	head: { appendChild() {} },
	createElement() {
		return { dataset: {}, textContent: '' };
	}
};

new Function('window', 'document', 'console', code)(fakeWindow, fakeDocument, console);

const definition = modules.get('dsh-tmp-cleaner');
assert.ok(definition, 'bundle registers id "dsh-tmp-cleaner"');

const fakeReact = {
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (value) => ({ current: value }),
	createElement: () => null
};
const fakeJsxRuntime = {
	jsx: (type, props) => ({ type, props }),
	jsxs: (type, props) => ({ type, props }),
	Fragment: Symbol('Fragment')
};

const required = [];
const requireImpl = (specifier) => {
	required.push(specifier);
	if (specifier === 'react') return fakeReact;
	if (specifier === 'react/jsx-runtime') return fakeJsxRuntime;
	throw new Error('unexpected module request: ' + specifier);
};

const bundle = definition.factory(requireImpl);
assert.equal(typeof bundle.apply, 'function');
assert.ok(Array.isArray(bundle.inject));
assert.ok(bundle.inject.includes('slots'));

let registered = null;
let slotName = null;
const ctx = {
	slots: {
		inject(name, callback) {
			slotName = name;
			callback();
		},
		register(options, component) {
			registered = { options, component };
			return () => {};
		}
	}
};

bundle.apply(ctx);
assert.equal(slotName, 'settings.section');
assert.equal(registered.options.name, 'settings.section');
assert.equal(registered.options.id, 'tmp-cleaner');
assert.equal(typeof registered.options.label, 'function');
assert.equal(registered.options.label(), '临时清理');
assert.equal(typeof registered.component, 'function');

const tree = registered.component({});
assert.ok(tree && typeof tree === 'object', 'component renders a tree');
console.log('[client-test] required modules:', required.join(', '));
console.log('[client-test] PASS — registers settings.section["tmp-cleaner"], renders:', tree.type, JSON.stringify(tree.props.children).slice(0, 40));
