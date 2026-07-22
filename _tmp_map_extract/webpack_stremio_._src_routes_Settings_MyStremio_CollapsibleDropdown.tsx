"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = __importDefault(require("react"));
var NativeDropdown_1 = __importDefault(require("./NativeDropdown"));
var CollapsibleDropdown = function (_a) {
    var summary = _a.summary, open = _a.open, onToggle = _a.onToggle, _b = _a.panelFit, panelFit = _b === void 0 ? false : _b, children = _a.children;
    return (react_1.default.createElement(NativeDropdown_1.default, { summary: summary, open: open, onToggle: onToggle, onClose: function () {
            if (open)
                onToggle();
        }, panelFit: panelFit }, children));
};
exports.default = CollapsibleDropdown;
