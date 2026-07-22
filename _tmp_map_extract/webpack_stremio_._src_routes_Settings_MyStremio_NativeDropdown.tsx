"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = __importStar(require("react"));
var react_dom_1 = require("react-dom");
var components_1 = require("stremio/components");
var react_2 = __importDefault(require("@stremio/stremio-icons/react"));
var classnames_1 = __importDefault(require("classnames"));
var MultiselectMenu_less_1 = __importDefault(require("../../../components/MultiselectMenu/MultiselectMenu.less"));
var Dropdown_less_1 = __importDefault(require("../../../components/MultiselectMenu/Dropdown/Dropdown.less"));
var MyStremio_less_1 = __importDefault(require("./MyStremio.less"));
var NativeDropdown = function (_a) {
    var _b, _c, _d;
    var summary = _a.summary, open = _a.open, onToggle = _a.onToggle, onClose = _a.onClose, _e = _a.panelFit, panelFit = _e === void 0 ? false : _e, children = _a.children;
    var rootRef = (0, react_1.useRef)(null);
    var triggerRef = (0, react_1.useRef)(null);
    var panelRef = (0, react_1.useRef)(null);
    var _f = (0, react_1.useState)(null), panelStyle = _f[0], setPanelStyle = _f[1];
    var close = (0, react_1.useCallback)(function () {
        if (!open)
            return;
        if (onClose)
            onClose();
        else
            onToggle();
    }, [open, onClose, onToggle]);
    (0, react_1.useEffect)(function () {
        if (!open)
            return;
        var onPointerDown = function (event) {
            var _a, _b;
            var target = event.target;
            if (!target)
                return;
            if ((_a = rootRef.current) === null || _a === void 0 ? void 0 : _a.contains(target))
                return;
            if ((_b = panelRef.current) === null || _b === void 0 ? void 0 : _b.contains(target))
                return;
            close();
        };
        document.addEventListener('mousedown', onPointerDown, true);
        return function () {
            document.removeEventListener('mousedown', onPointerDown, true);
        };
    }, [open, close]);
    (0, react_1.useEffect)(function () {
        if (!open || !panelFit) {
            setPanelStyle(null);
            return;
        }
        var updatePanelPosition = function () {
            var root = rootRef.current;
            var trigger = triggerRef.current;
            if (!root || !trigger)
                return;
            var rootRect = root.getBoundingClientRect();
            var triggerRect = trigger.getBoundingClientRect();
            if (rootRect.width < 1 || triggerRect.height < 1)
                return;
            setPanelStyle({
                top: Math.round(triggerRect.bottom + 2),
                left: Math.round(rootRect.left),
                width: Math.round(rootRect.width),
            });
        };
        updatePanelPosition();
        window.addEventListener('resize', updatePanelPosition);
        window.addEventListener('scroll', updatePanelPosition, true);
        return function () {
            window.removeEventListener('resize', updatePanelPosition);
            window.removeEventListener('scroll', updatePanelPosition, true);
        };
    }, [open, panelFit]);
    var panelClassName = (0, classnames_1.default)(Dropdown_less_1.default['dropdown'], Dropdown_less_1.default['open'], panelFit && MyStremio_less_1.default['custom-dropdown-panel-portal'], panelFit && MyStremio_less_1.default['custom-dropdown-panel-fit']);
    var panel = open && children != null ? (panelFit && panelStyle ? (0, react_dom_1.createPortal)(react_1.default.createElement("div", { ref: panelRef, className: panelClassName, style: {
            position: 'fixed',
            top: "".concat(panelStyle.top, "px"),
            left: "".concat(panelStyle.left, "px"),
            width: "".concat(panelStyle.width, "px"),
            zIndex: 10000,
        } }, children), document.body) : (react_1.default.createElement("div", { className: panelClassName }, children))) : null;
    return (react_1.default.createElement("div", { ref: rootRef, className: (0, classnames_1.default)(MultiselectMenu_less_1.default['multiselect-menu'], (_b = {}, _b[MultiselectMenu_less_1.default['active']] = open, _b), 'multiselect', MyStremio_less_1.default['dropdown-wrap']) },
        react_1.default.createElement(components_1.Button, { ref: triggerRef, className: (0, classnames_1.default)(MultiselectMenu_less_1.default['multiselect-button'], (_c = {}, _c[MultiselectMenu_less_1.default['open']] = open, _c)), onClick: onToggle, tabIndex: 0, "aria-haspopup": 'listbox', "aria-expanded": open },
            react_1.default.createElement("div", { className: MultiselectMenu_less_1.default['label'] }, summary),
            react_1.default.createElement(react_2.default, { name: 'caret-down', className: (0, classnames_1.default)(MultiselectMenu_less_1.default['icon'], (_d = {}, _d[MultiselectMenu_less_1.default['open']] = open, _d)) })),
        panel));
};
exports.default = NativeDropdown;
