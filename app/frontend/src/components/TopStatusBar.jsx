import React, { memo, useState, useRef, useEffect } from "react";
import { Sun, Moon, Palette, Check, PanelLeft } from "lucide-react";
import { THEMES } from "../themes";

function TopStatusBar({
  theme,
  setTheme,
  sidebarVisible,
  onToggleSidebar,
}) {
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowThemeMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const isDark = (theme || "dark").startsWith("dark");

  return (
    <div className="top-status-bar">
      <div className="top-status-bar-start">
        {!sidebarVisible && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="sidebar-toggle-btn"
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            <PanelLeft size={18} />
          </button>
        )}
      </div>

      <div className="telemetry-group" style={{ position: "relative" }}>
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
          title={`Switch to ${isDark ? "light" : "dark"} theme`}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
          <button
            type="button"
            aria-label="Choose a color theme"
            aria-expanded={showThemeMenu}
            className={`theme-toggle-btn ${showThemeMenu ? "active" : ""}`}
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            title="Choose a custom color theme"
          >
            <Palette size={18} />
          </button>

          {showThemeMenu && (
            <div className="theme-dropdown-menu">
              <div className="theme-dropdown-header">Select Theme</div>
              <div className="theme-dropdown-divider"></div>
              {THEMES.map((t) => {
                const isActive = theme === t.id;
                return (
                  <button
                    key={t.id}
                    className={`theme-dropdown-item ${isActive ? "active" : ""}`}
                    onClick={() => {
                      setTheme(t.id);
                      setShowThemeMenu(false);
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.primary }} />
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.secondary }} />
                      </div>
                      <span className="theme-name-text">{t.name}</span>
                      {isActive && <Check size={12} style={{ marginLeft: "auto", color: "var(--md-sys-color-primary)" }} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(TopStatusBar);
