"use strict";
// Copyright (C) 2017-2024 Smart code 203358507
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
var components_1 = require("stremio/components");
var react_i18next_1 = require("react-i18next");
var classnames_1 = __importDefault(require("classnames"));
var Option_1 = __importDefault(require("./Option"));
var react_2 = __importDefault(require("@stremio/stremio-icons/react"));
var Dropdown_less_1 = __importDefault(require("./Dropdown.less"));
var Dropdown = function (_a) {
    var _b;
    var level = _a.level, setLevel = _a.setLevel, options = _a.options, onSelect = _a.onSelect, value = _a.value, menuOpen = _a.menuOpen;
    var t = (0, react_i18next_1.useTranslation)().t;
    var optionsRef = (0, react_1.useRef)(new Map());
    var containerRef = (0, react_1.useRef)(null);
    var selectedOption = options.find(function (opt) { return opt.value === value; });
    var handleSetOptionRef = (0, react_1.useCallback)(function (optionValue) { return function (node) {
        if (node) {
            optionsRef.current.set(optionValue, node);
        }
        else {
            optionsRef.current.delete(optionValue);
        }
    }; }, []);
    var handleBackClick = (0, react_1.useCallback)(function () {
        setLevel(level - 1);
    }, [setLevel, level]);
    (0, react_1.useEffect)(function () {
        if (menuOpen && selectedOption && containerRef.current) {
            var selectedNode = optionsRef.current.get(selectedOption.value);
            if (selectedNode) {
                selectedNode.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest'
                });
            }
        }
    }, [menuOpen, selectedOption]);
    return (react_1.default.createElement("div", { className: (0, classnames_1.default)(Dropdown_less_1.default['dropdown'], (_b = {}, _b[Dropdown_less_1.default['open']] = menuOpen, _b)), role: 'listbox', ref: containerRef },
        level > 0 ?
            react_1.default.createElement(components_1.Button, { className: Dropdown_less_1.default['back-button'], onClick: handleBackClick },
                react_1.default.createElement(react_2.default, { name: 'caret-left', className: Dropdown_less_1.default['back-button-icon'] }),
                t('BACK'))
            : null,
        options
            .filter(function (option) { return !option.hidden; })
            .map(function (option) { return (react_1.default.createElement(Option_1.default, { key: option.value, ref: handleSetOptionRef(option.value), option: option, onSelect: onSelect, selectedValue: value })); })));
};
exports.default = Dropdown;
