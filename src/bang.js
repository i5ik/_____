(function () {
  // constants, classes, config and state
    const DEBUG = false;
    const OPTIMIZE = true;
    const GET_ONLY = true;
    const MOBILE = isMobile();
    const DOUBLE_BARREL = /\w+-\w*/; // note that this matches triple- and higher barrels, too
    const F = _FUNC; 
    const FUNC_CALL = /\);?$/;
    const MirrorNode = Symbol.for('[[MN]]');
    const Template = document.createElement('template');
    const path = location.pathname;
    const CONFIG = {
      htmlFile: 'markup.html',
      scriptFile: 'script.js',
      styleFile: 'style.css',
      bangKey: '_bang_key',
      componentsPath: `${path}${path.endsWith('/') ? '' : '/'}components`,
      allowUnset: false,
      unsetPlaceholder: '',
      EVENTS: `error load click pointerdown pointerup pointermove mousedown mouseup 
        mousemove touchstart touchend touchmove touchcancel dblclick dragstart dragend 
        dragmove drag mouseover mouseout focus blur focusin focusout scroll
        input change compositionstart compositionend text paste beforepast select cut copy
        contextmenu
      `.split(/\s+/g).filter(s => s.length).map(e => `on${e}`),
      delayFirstPaintUntilLoaded: true,
      capBangRatioAtUnity: false,
      noHandlerPassthrough: false
    };
    const History = [];
    const STATE = new Map();
    const CACHE = new Map();
    const Waiters = new Map();
    const Started = new Set();
    const TRANSFORMING = new WeakSet();
    const Dependents = new Map();
    class Counters {
      started = 0;
      finished = 0;
    }
    const Counts = new Counters;
    self.counts = [];
    const OBSERVE_OPTS = {subtree: true, childList: true, characterData: true};
    let hindex = 0;
    let observer; // global mutation observer
    let systemKeys = 1;
    let _c$;

    const BangBase = (name) => class Base extends HTMLElement {
      static #activeAttrs = ['state']; // we listen for changes to these attributes only
      static get observedAttributes() {
        return Array.from(Base.#activeAttrs);
      }
      #name = name;

      constructor({task: task = () => void 0} = {}) {
        super();
        DEBUG && say('log',name, 'constructed');
        this.counts = new Counters;
        this.prepareVisibility();
        this.print().then(task);
      }

      connectedCallback() {
      }

      get name() {
        return this.#name;
      }

      // BANG! API methods
      async print() {
        if ( !this.alreadyPrinted ) {
          this.counts.started++;
        }
        const state = this.handleAttrs(this.attributes);
        if ( OPTIMIZE ) {
          const nextState = JSON.stringify(state);
          if ( this.alreadyPrinted && this.lastState === nextState ) {
            DEBUG && console.log(this, 'state no change, returning');
            return;
          }
          this.lastState = nextState;
        }
        return this.printShadow(state)
          .then(() => this.alreadyPrinted = true)
      }

      connectedCallback() {
        say('log',name, 'connected');
        // lazy loaders have their own count scope, but not lazy ones 
        // contributes their counts to the global count scope
        if ( this.hasAttribute('lazy') ) {
          DEBUG && console.log('Not sending counts of lazy', this, 'to anyone');
        } else if ( ! this.includedInLazyParentCounts ) {
          this.includedInLazyParentCounts = true;
          const lazyParent = furthest(this, '[lazy]');
          let target = Counts;
          if ( lazyParent ) {
            target = lazyParent.counts; 
            //console.log('Counting', this, 'in parent', lazyParent);
          } else {
            //console.log('Counting', this, 'in global', target);
            self.counts.push(target);
          }
          target.started += this.counts.started;
          target.finished += this.counts.finished;
          this.counts = target;
        }
        // attributes must be assigned on connection so we can search for
        // references to parents
        this.handleAttrs(this.attributes, {originals: true});
      }

      prepareVisibility() {
        this.classList.add('bang-el');
        this.classList.remove('bang-styled');
        // this is like an onerror event for stylesheet's 
          // we do this because we want to display elements if they have no stylesheet defined
          // becuase it's reasonabgle to want to not include a stylesheet with your custom element
        fetchStyle(name).catch(err => this.setVisible());
      }

      setVisible() {
        //this.classList.add('bang-styled');
      }

      // Web Components methods
      attributeChangedCallback(name, oldValue, value) {
        // setting the state attribute casues the custom element to re-render
        if ( name === 'state' && !isUnset(oldValue) ) {
          if ( STATE.get(oldValue+'.json.last') !== JSON.stringify(STATE.get(value)) ) {
            DEBUG && say('log',`Changing state, so calling print.`, oldValue, value, this);
            this.print();
          }
        }
      }

      // private methods
      handleAttrs(attrs, {node, originals} = {}) {
        let state = {};

        if ( ! node ) node = this;

        for( let {name,value} of attrs ) {
          if ( isUnset(value) ) continue;
          if ( name === 'state' ) {
            const stateKey = value; 
            const stateObject = cloneState(stateKey);
            
            if ( isUnset(stateObject) ) {
              throw new TypeError(`
                <${name}> constructor passed state key ${stateKey} which is unset. It must be set.
              `);
            }
            
            state = stateObject;
            
            if ( originals ) {
              let acquirers = Dependents.get(stateKey);
              if ( ! acquirers ) {
                acquirers = new Set();
                Dependents.set(stateKey, acquirers);
              }
              acquirers.add(node);
              DEBUG && console.log({acquirers, Dependents});
            }
          } else if ( originals ) { // set event handlers to custom element class instance methods
            if ( ! name.startsWith('on') ) continue;
            value = value.trim();
            if ( ! value ) continue;

            const Local = () => node[value];
            const Parent = () => node.getRootNode().host[value];
            const path = Local() ? 'this.' 
              : Parent() ? 'this.getRootNode().host.' 
              : null;
            if ( ! path ) continue;

            if ( value.startsWith(path) ) continue;
            // Conditional logic explained:
              // don't add a function call bracket if
              // 1. it already has one
              // 2. the reference is not a function
            const ender = ( 
              value.match(FUNC_CALL) || 
              !(typeof Local() === "function" || typeof Parent() === "function")
            ) ? '' : '(event)';
            node.setAttribute(name, `${path}${value}${ender}`);
          }
        }

        return state;
      }

      printShadow(state) {
        return fetchMarkup(this.#name, this).then(async markup => {
          const cooked = await cook.call(this, markup, state);
          DEBUG && console.log(cooked);
          if ( this.shadowRoot ) {
            //this.shadowRoot.replaceChildren(nodes);
          } else {
            const shadow = this.attachShadow({mode:'open'});
            //console.log({observer});
            observer.observe(shadow, OBSERVE_OPTS);
            cooked.to(shadow, 'insert');
            const listening = shadow.querySelectorAll(CONFIG.EVENTS.map(e => `[${e}]`).join(', '));
            listening.forEach(node => this.handleAttrs(node.attributes, {node, originals: true}));
          }
            if ( ! this.counts.stop ) {
              this.counts.finished++;
            }
            //await sleep(100);
            if ( this.counts.finished >= this.counts.started ) {
              //console.log(this.counts);
              this.classList.add('bang-styled');
              this.counts.stop = true;
            }
        })
        .catch(err => DEBUG && say('warn',err))
        .finally(async () => {
          if ( ! this.counts.stop ) {
            this.counts.finished++;
          } else return;
          await sleep(100);
          if ( this.counts.finished >= this.counts.started ) {
            //console.log(this.counts);
            this.classList.add('bang-styled');
            this.counts.stop = true;
          }
        });
      }
    };

    class StateKey extends String {
      constructor (keyNumber) {
        if ( keyNumber == undefined ) super(`system-key:${systemKeys++}`); 
        else super(`client-key:${keyNumber}`);
      }
    }

  install();

  // API
    async function use(name) {
      let component;
      await fetchScript(name)
        .then(script => { // if there's a script that extends base, evaluate it to be component
          const Base = BangBase(name);
          const Compose = `(function () { ${Base.toString()}; return ${script}; }())`;
          try {
            component = eval(Compose);
          } catch(e) {
            DEBUG && say('warn',e, Compose, component)
          }
        }).catch(() => {  // otherwise if there is no such extension script, just use the Base class
          component = BangBase(name);
        });
      
      self.customElements.define(name, component);
      DEBUG && self.customElements.whenDefined(name).then(obj => say('log',name, 'defined', obj));
    }

    function undoState(key, transform = x => x) {
      while( hindex > 0 ) {
        hindex -= 1;
        if ( History[hindex].name === key ) {
          setState(key, transform(History[hindex].value));
          DEBUG && console.log('Undo state to', History[hindex], hindex, History);
          return true;
        }
      }
      return false;
    }

    function redoState(key, transform = x => x) {
      while( hindex < History.length - 1 ) {
        hindex += 1;
        if ( History[hindex].name === key ) {
          setState(key, transform(History[hindex].value));
          DEBUG && console.log('Redo state to', History[hindex], hindex, History);
          return true;
        }
      }
      return false;
    }

    function bangFig(newConfig = {}) {
      Object.assign(CONFIG, newConfig);
    }

    function setState(key, state, {
      rerender: rerender = true, 
      save: save = false
    } = {}) {
      if ( GET_ONLY ) {
        if ( !STATE.has(key) ) {
          STATE.set(key, state);
          STATE.set(state, key);
          DEBUG && console.log('Setting stringified state', state, key);
          STATE.set(JSON.stringify(state), key+'.json.last');
          STATE.set(key+'.json.last',JSON.stringify(state));
        } else {
          DEBUG && console.log('Updating state', key);
          const oState = STATE.get(key);
          const oStateJSON = STATE.get(key+'.json.last');
          if ( JSON.stringify(state) !== oStateJSON ) {
            DEBUG && console.log('State really changed. Will update', key);
            Object.assign(oState, state);
            STATE.delete(oStateJSON);
            if ( key.startsWith('system-key:') ) {
              STATE.delete(key);
              STATE.delete(key+'.json.last');
              key = new StateKey();
              STATE.set(key, oState);
              STATE.set(oState, key);
            }
            const stateJSONLast = JSON.stringify(oState);
            STATE.set(key+'.json.last', stateJSONLast);
            STATE.set(stateJSONLast, key+'.json.last');
          }
        }
      } else {
        STATE.set(key, state);
        STATE.set(state, key);
        STATE.set(JSON.stringify(state), key+'.json.last');
        STATE.set(key+'.json.last',JSON.stringify(state));
      }

      if ( save ) {
        hindex = Math.min(hindex+1, History.length);
        History.splice(hindex, 0, {name: key, value: clone(state)});
        DEBUG && console.log('set state history add', hindex, History.length-1, History);
      }

      if ( rerender ) { // re-render only those components depending on that key
        const acquirers = Dependents.get(key);
        DEBUG && console.log({acquirers, Dependents});
        if ( acquirers ) acquirers.forEach(host => host.print());
      }
    }

    function patchState(key, state) {
      return setState(key, state, {rerender: false});
    }

    function cloneState(key, getOnly = GET_ONLY) {
      if ( getOnly ) return STATE.get(key);
      if ( STATE.has(key) ) return clone(STATE.get(key));
      else {
        throw new TypeError(`State store does not have the key ${key}`);
      }
    }

    async function loaded(prop = 1.0) {
      if ( isUnset(prop) || Number.isNaN(prop) ) prop = 1.0;
      CONFIG.capBangRatioAtUnity && (prop = Math.min(1.0,prop));

      const loadCheck = () => {
        prop = globalThis.bangRatio || prop;
        if ( isUnset(prop) || Number.isNaN(prop) ) prop = 1.0;
        CONFIG.capBangRatioAtUnity && (prop = Math.min(1.0,prop));

        const nonZeroCount = Counts.started > 0; 
        const finishedWhatWeStarted = Counts.finished >= prop * Counts.started;
        //console.log(Counts);
        return nonZeroCount && finishedWhatWeStarted;
      };
      return becomesTrue(loadCheck);
    }

    async function bangLoaded() {
      const loadCheck = () => {
        const c_defined = typeof _c$ === "function";
        return c_defined;
      };
      return becomesTrue(loadCheck);
    }

  // helpers
    function closest(node, selector = '*') {
      while(node) {
        if ( node && node.nodeType === Node.ELEMENT_NODE ) {
          if ( node.matches(selector) ) return node;
        }
        if ( node.parentNode ) {
          node = node.parentNode;
        } else {
          node = node.host;
        }
      }
    }

    function furthest(node, selector = '*') {
      const ancestors = [];
      while(node) {
        if ( node && node.nodeType === Node.ELEMENT_NODE ) {
          ancestors.unshift(node);
        }
        if ( node.parentNode ) {
          node = node.parentNode;
        } else {
          node = node.host;
        }
      }
      return ancestors.find(element => element.matches(selector));
    }

    async function install() {
      Object.assign(globalThis, {
        use, setState, patchState, cloneState, loaded, 
        sleep, bangFig, bangLoaded, isMobile, trace,
        undoState, redoState,
        dateString,
        ...( DEBUG ? { STATE, CACHE, TRANSFORMING, Started, BangBase } : {})
      });

      const module = globalThis.vanillaview || (await import('./vv/vanillaview.js'));
      const {s} = module;
      const That = {STATE,CONFIG,StateKey}; 
      _c$ = s.bind(That);
      That._c$ = _c$;

      if ( CONFIG.delayFirstPaintUntilLoaded ) {
        becomesTrue(() => document.body).then(() => document.body.classList.add('bang-el'));
      }

      observer = new MutationObserver(transformBangs);
      /* we are interested in bang nodes (which start as comments) */
      observer.observe(document, OBSERVE_OPTS);
      findBangs(transformBang); 
      
      loaded(globalThis.bangRatio).then(() => document.body.classList.add('bang-styled'));
    }

    async function fetchMarkup(name, comp) {
      // cache first
        // we make any subsequent calls for name wait for the first call to complete
        // otherwise we create many in parallel without benefitting from caching

      const key = `markup:${name}`;

      if ( Started.has(key) ) {
        if ( ! CACHE.has(key) ) await cacheHasKey(key);
      } else Started.add(key);

      const styleKey = `style${name}`;
      const baseUrl = `${CONFIG.componentsPath}/${name}`;
      if ( CACHE.has(key) ) {
        const markup = CACHE.get(key);
        if ( CACHE.get(styleKey) instanceof Error ) comp && comp.setVisible();
        
        // if there is an error style and we are still includig that link
        // we generate and cache the markup again to omit such a link element
        if ( CACHE.get(styleKey) instanceof Error && markup.includes(`href=${baseUrl}/${CONFIG.styleFile}`) ) {
          // then we need to set the cache for markup again and remove the link to the stylesheet which failed 
        } else {
          comp && comp.setVisible();
          return markup;
        }
      }
      
      const markupUrl = `${baseUrl}/${CONFIG.htmlFile}`;
      let resp;
      const markupText = await fetch(markupUrl).then(async r => { 
        let text = '';
        if ( r.ok ) text = await r.text();
        else text = `<slot></slot>`;        // if no markup is given we just insert all content within the custom element
      
        if ( CACHE.get(styleKey) instanceof Error ) { 
          resp = `<style>
            @import url('${CONFIG.componentsPath}/style.css');
          </style>${text}` 
        } else {
          // inlining styles for increase speed */
            // we setVisible (add bang-styled) straight away because the inline styles block the markup
            // so no FOUC while stylesheet link is loading, like previously: resp = `
            // <link rel=stylesheet href=${baseUrl}/${CONFIG.styleFile} onload=setVisible>${text}`;
          resp = `<style>
            @import url('${CONFIG.componentsPath}/style.css');
            ${await fetchStyle(name).then(e => {
              if ( e instanceof Error ) return `/* no ${name}/style.css defined */`;
              return e;
            })}
          </style>${text}`;
        }
        comp && comp.setVisible();
        
        return resp;
      }).finally(async () => CACHE.set(key, await resp));
      return markupText;
    }

    async function fetchFile(name, file) {
      const key = `${file}:${name}`;

      if ( Started.has(key) ) {
        if ( ! CACHE.has(key) ) await cacheHasKey(key);
      } else Started.add(key);

      if ( CACHE.has(key) ) return CACHE.get(key);

      const url = `${CONFIG.componentsPath}/${name}/${file}`;
      let resp;
      const fileText = await fetch(url).then(r => { 
        if ( r.ok ) {
          resp = r.text();
          return resp;
        } 
        resp = new TypeError(`Fetch error: ${url}, ${r.statusText}`);
        throw resp;
      }).finally(async () => CACHE.set(key, await resp));
      
      return fileText;
    }

    async function fetchStyle(name) {
      return fetchFile(name, CONFIG.styleFile);
    }

    async function fetchScript(name) {
      return fetchFile(name, CONFIG.scriptFile);
    }

    // search and transform each added subtree
    function transformBangs(records) {
      records.forEach(record => {
        DEBUG && say('log',record);
        const {addedNodes} = record;
        if ( !addedNodes ) return;
        addedNodes.forEach(node => findBangs(transformBang, node));
      });
    }

    function transformBang(current) {
      DEBUG && say('log',{transformBang},{current});
      const [name, data] = getBangDetails(current);
      DEBUG && say('log',{name, data});

      // replace the bang node (comment) with its actual custom element node
      const actualElement = createElement(name, data);
      current.linkedCustomElement = actualElement;
      DEBUG && console.log(current, actualElement);
      actualElement[MirrorNode] = current;
      current.parentNode.replaceChild(actualElement, current);
    }

    function findBangs(callback, root = document.documentElement) {
      const Acceptor = {
        acceptNode(node) {
          if ( node.nodeType !== Node.COMMENT_NODE ) return NodeFilter.FILTER_SKIP;
          const [name] = getBangDetails(node); 
          if ( name.match(DOUBLE_BARREL) ) return NodeFilter.FILTER_ACCEPT;
          else return NodeFilter.FILTER_REJECT;
        }
      };
      const iterator = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT, Acceptor);
      const replacements = [];

      // handle root node
        // it's a special case because it will be present in the iteration even if
        // the NodeFilter would filter it out if it were not the root
      let current = iterator.currentNode;

      if ( Acceptor.acceptNode(current) === NodeFilter.FILTER_ACCEPT ) {
        if ( !TRANSFORMING.has(current) ) {
          TRANSFORMING.add(current);
          const target = current;
          replacements.push(() => transformBang(target));
        }
      }

      // handle any descendents
        while (true) {
          current = iterator.nextNode();
          if ( ! current ) break;

          if ( !TRANSFORMING.has(current) ) {
            TRANSFORMING.add(current);
            const target = current;
            replacements.push(() => transformBang(target));
          }
        }

      while(replacements.length) replacements.pop()();
    }

    function getBangDetails(node) {
      const text = node.textContent.trim();
      const [name, ...data] = text.split(/[\s\t]/g);
      return [name, data.join(' ')];
    }

    async function process(x, state) {
      const tox = typeof x;
      if ( tox === 'string' ) return x;
      else 

      if ( tox === 'number' ) return x+'';
      else

      if ( tox === 'boolean' ) return x+'';
      else

      if ( x instanceof Date ) return x+'';
      else

      if ( isUnset(x) ) {
        if ( CONFIG.allowUnset ) return CONFIG.unsetPlaceholder || '';
        else {
          throw new TypeError(`Value cannot be unset, was: ${x}`);
        }
      }
      else

      if ( x instanceof Promise ) return await x.catch(err => err+'');
      else

      if ( x instanceof Element ) return x.outerHTML;
      else

      if ( x instanceof Node ) return x.textContent;
      else

      if ( isIterable(x) ) {
        // if an Array or iterable is given then
        // its values are recursively processed via this same function
        return (await Promise.all(
          (
            await Promise.all(Array.from(x)).catch(e => err+'')
          ).map(v => process(v, state))
        )).join(' ');
      }
      else

      if ( Object.getPrototypeOf(x).constructor.name === 'AsyncFunction' ) return await x(state);
      else

      if ( x instanceof Function ) return x(state);
      else // it's an object, of some type 

      {
        // State store     
          /* so we assume an object is state and save it */
          /* to the global state store */
          /* which is two-sides so we can find a key */
          /* given an object. This avoid duplicates */
        const jx = JSON.stringify(x);
        let stateKey;

        // own keys
          // an object can specify it's own state key
          // to provide a single logical identity for a piece of state that may
          // be represented by many objects

        if ( Object.prototype.hasOwnProperty.call(x, CONFIG.bangKey) ) {
          stateKey = new StateKey(x[CONFIG.bangKey])+'';
          const jk = stateKey+'.json.last';
          // in that case, replace the previously saved object with the same logical identity
          const oldX = STATE.get(jk);
          if ( oldX !== jx ) {
            STATE.delete(oldX);
            STATE.delete(STATE.get(stateKey));

            STATE.set(stateKey, x);
            STATE.set(x, stateKey);
            STATE.set(jx, jk);
            STATE.set(jk,jx);
          }
        } 

        else  /* or the system can come up with a state key */

        {
          if ( STATE.has(jx) ) stateKey = STATE.get(jx);
          else {
            stateKey = new StateKey()+'';
            const jk = stateKey+'.json.last';
            STATE.set(stateKey, x);
            STATE.set(x, stateKey);
            STATE.set(js, jk);
            STATE.set(jk,jx);
          }
        }

        stateKey += '';
        DEBUG && say('log',{stateKey});
        return stateKey;
      }
    }

    async function cook(markup, state) {
      const that = this;
      let cooked = '';
      try {
        if ( !Object.prototype.hasOwnProperty.call(state, '_self') ) {
          Object.defineProperty(state, '_self', {
            get: () => state
          });
        }
        DEBUG && say('log','_self', state._self);
      } catch(e) {
        DEBUG && say('warn',
          `Cannot add '_self' self-reference property to state. 
            This enables a component to inspect the top-level state object it is passed.`
        );
      }
      try {
        with(state) {
          cooked = await eval("(async function () { return await _FUNC`${{state}}"+markup+"`; }())");  
        }
        DEBUG && console.log({cooked});
        return cooked;
      } catch(error) {
        say('error', 'Template error', {markup, state, error});
        throw error;
      }
    }

    async function _FUNC(strings, ...vals) {
      const s = Array.from(strings);
      const ret =  await _c$(s, ...vals);
      return ret;
    }

    function createElement(name, data) {
      return toDOM(`<${name} ${data}></${name}>`).firstElementChild;
    }

    function toDOM(str) {
      Template.innerHTML = str;
      return Template.content;
    }

    async function becomesTrue(check = () => true) {
      return new Promise(async res => {
        while(true) {
          await sleep(47);
          if ( check() ) break;
        }
        res();
      });
    }

    // this is to optimize using becomesTrue so we don't start a new timer
    // for every becomesTrue function call (in the case of the cache check, anyway)
    // we can use this pattern to apply to other becomesTrue calls like loaded
    async function cacheHasKey(key) {
      try {
        const WaitKey = `cache:${key}`;
        let waiters = Waiters.get(WaitKey);
        if ( ! waiters ) {
          const list = [];
          waiters = {
            WaitKey,
            list,
            event: becomesTrue(() => CACHE.has(key)).then(() => list.reverse().forEach(res => res()))
          };
          Waiters.set(WaitKey, waiters);
          DEBUG && console.log('Setup waiter list', waiters);
        }
        let res;
        const pr = new Promise(resolve => res = resolve);
        waiters.list.push(res);
        return pr;
      } catch(e) {
        console.warn(e);
      }
    }

    async function sleep(ms) {
      return new Promise(res => setTimeout(res, ms));
    }

    function isIterable(y) {
      if ( y === null ) return false;
      return y[Symbol.iterator] instanceof Function;
    }

    function isUnset(x) {
      return x === undefined || x === null;
    }

    function say(mode, ...stuff) {
      (DEBUG || mode === 'error' || mode.endsWith('!')) && MOBILE && alert(`${mode}: ${stuff.join('\n')}`);
      (DEBUG || mode === 'error' || mode.endsWith('!')) && console[mode.replace('!','')](...stuff);
    }

    function isMobile() {
      const toMatch = [
        /Android/i,
        /webOS/i,
        /iPhone/i,
        /iPad/i,
        /iPod/i,
        /BlackBerry/i,
        /Windows Phone/i
      ];

      return toMatch.some((toMatchItem) => {
        return navigator.userAgent.match(toMatchItem);
      });
    }
  
    function trace(msg = '') {
      const tracer = new Error('Trace');
      console.log(msg, 'Call stack', tracer.stack);
    }

    function dateString(date) {
      const offset = date.getTimezoneOffset()
      date = new Date(date.getTime() - (offset*60*1000))
      return date.toISOString().split('T')[0];
    }

    function clone(o) {
      return JSON.parse(JSON.stringify(o));
    }
}());


