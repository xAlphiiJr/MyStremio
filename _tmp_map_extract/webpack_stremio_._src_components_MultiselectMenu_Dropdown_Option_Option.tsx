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
var classnames_1 = __importDefault(require("classnames"));
var components_1 = require("stremio/components");
var Option_less_1 = __importDefault(require("./Option.less"));
var react_2 = __importDefault(require("@stremio/stremio-icons/react"));
var Option = (0, react_1.forwardRef)(function (_a, ref) {
    var _b;
    var option = _a.option, selectedValue = _a.selectedValue, onSelect = _a.onSelect;
    var selected = (0, react_1.useMemo)(function () { return (option === null || option === void 0 ? void 0 : option.value) === selectedValue; }, [option, selectedValue]);
    var handleClick = (0, react_1.useCallback)(function () {
        onSelect(option.value);
    }, [onSelect, option.value]);
    return (react_1.default.createElement(components_1.Button, { ref: ref, className: (0, classnames_1.default)(Option_less_1.default['option'], (_b = {}, _b[Option_less_1.default['selected']] = selected, _b)), key: option.id, onClick: handleClick, "aria-selected": selected },
        react_1.default.createElement("div", { className: Option_less_1.default['label'] }, option.label),
        selected && !option.level ?
            react_1.default.createElement("div", { className: Option_less_1.default['icon'] })
            : null,
        option.level ?
            react_1.default.createElement(react_2.default, { name: 'caret-right', className: Option_less_1.default['option-caret'] })
            : null));
});
Option.displayName = 'Option';
exports.default = Option;
