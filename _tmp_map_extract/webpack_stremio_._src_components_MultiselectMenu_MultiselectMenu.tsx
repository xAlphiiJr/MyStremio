"use strict";
// Copyright (C) 2017-2024 Smart code 203358507
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = __importDefault(require("react"));
var components_1 = require("stremio/components");
var useBinaryState_1 = __importDefault(require("stremio/common/useBinaryState"));
var Dropdown_1 = __importDefault(require("./Dropdown"));
var classnames_1 = __importDefault(require("classnames"));
var react_2 = __importDefault(require("@stremio/stremio-icons/react"));
var MultiselectMenu_less_1 = __importDefault(require("./MultiselectMenu.less"));
var useOutsideClick_1 = __importDefault(require("stremio/common/useOutsideClick"));
var MultiselectMenu = function (_a) {
    var _b, _c, _d;
    var className = _a.className, title = _a.title, options = _a.options, value = _a.value, disabled = _a.disabled, onSelect = _a.onSelect;
    var _e = (0, useBinaryState_1.default)(false), menuOpen = _e[0], closeMenu = _e[2], toggleMenu = _e[3];
    var multiselectMenuRef = (0, useOutsideClick_1.default)(function () { return closeMenu(); });
    var _f = react_1.default.useState(0), level = _f[0], setLevel = _f[1];
    var selectedOption = options.find(function (opt) { return opt.value === value; });
    var onOptionSelect = function (selectedValue) {
        if (level) {
            setLevel(level + 1);
        }
        else {
            onSelect(selectedValue);
        }
        closeMenu();
    };
    return (react_1.default.createElement("div", { className: (0, classnames_1.default)(MultiselectMenu_less_1.default['multiselect-menu'], (_b = {}, _b[MultiselectMenu_less_1.default['active']] = menuOpen, _b), className), ref: multiselectMenuRef },
        react_1.default.createElement(components_1.Button, { className: (0, classnames_1.default)(MultiselectMenu_less_1.default['multiselect-button'], (_c = {}, _c[MultiselectMenu_less_1.default['open']] = menuOpen, _c)), disabled: disabled, onClick: toggleMenu, tabIndex: 0, "aria-haspopup": 'listbox', "aria-expanded": menuOpen },
            react_1.default.createElement("div", { className: MultiselectMenu_less_1.default['label'] }, typeof title === 'function'
                ? title()
                : title !== null && title !== void 0 ? title : selectedOption === null || selectedOption === void 0 ? void 0 : selectedOption.label),
            react_1.default.createElement(react_2.default, { name: 'caret-down', className: (0, classnames_1.default)(MultiselectMenu_less_1.default['icon'], (_d = {}, _d[MultiselectMenu_less_1.default['open']] = menuOpen, _d)) })),
        menuOpen ?
            react_1.default.createElement(Dropdown_1.default, { level: level, setLevel: setLevel, options: options, onSelect: onOptionSelect, menuOpen: menuOpen, value: value })
            : null));
};
exports.default = MultiselectMenu;
