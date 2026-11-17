-- WowAuctionHelper: records your professions, skill levels and known recipes
-- so the web app can show only what you can craft.
--
-- Usage:
--   1. Log in on each character and open every profession window once
--      (Alchemy, Mining/Smelting, Enchanting, Cooking, First Aid, ...).
--      Works with the retail-style API of WoW Forever (C_TradeSkillUI) and
--      falls back to the Classic Era API (GetTradeSkillInfo / GetCraftInfo).
--   2. Type /wah  -> a box with an export string appears, Ctrl+C to copy,
--      paste it into the web app (Character tab).
--   Alternatively upload WTF/Account/<ACCOUNT>/SavedVariables/WowAuctionHelper.lua
--   into the web app; it contains all your characters.

local ADDON = ...
WowAuctionHelperDB = WowAuctionHelperDB or { version = 1, chars = {} }

local function charKey()
  local name = UnitName("player")
  local realm = GetRealmName() or "?"
  return name .. "-" .. realm, name, realm
end

local function charRecord()
  local key, name, realm = charKey()
  local db = WowAuctionHelperDB
  db.chars = db.chars or {}
  local c = db.chars[key]
  if not c then
    c = { trades = {}, skills = {} }
    db.chars[key] = c
  end
  c.name = name
  c.realm = realm
  c.faction = UnitFactionGroup("player")
  c.class = select(2, UnitClass("player"))
  c.level = UnitLevel("player")
  c.locale = GetLocale()
  c.updated = time()
  return c
end

-- Spell id from a recipe/enchant link like |Henchant:2330|h or |Hspell:2330|h
local function linkSpellId(link)
  if not link then return nil end
  local id = link:match("enchant:(%d+)") or link:match("spell:(%d+)")
  return id and tonumber(id) or nil
end

local function linkItemId(link)
  if not link then return nil end
  local id = link:match("item:(%d+)")
  return id and tonumber(id) or nil
end

-- All professions with rank and max rank. Retail-style API (WoW Forever):
-- GetProfessions() + GetProfessionInfo() give language-independent skill line ids.
-- Classic-style fallback: GetSkillLineInfo().
local function scanSkills()
  local c = charRecord()
  c.skills = {}
  if GetProfessions and GetProfessionInfo then
    local list = { GetProfessions() }
    for i = 1, 8 do
      local idx = list[i]
      if idx then
        local name, _, rank, maxRank, _, _, skillLine = GetProfessionInfo(idx)
        if name then c.skills[name] = { rank = rank, max = maxRank, id = skillLine } end
      end
    end
  end
  if next(c.skills) == nil and GetNumSkillLines then
    for i = 1, GetNumSkillLines() do
      local name, isHeader, _, rank, _, _, maxRank = GetSkillLineInfo(i)
      if name and not isHeader then
        c.skills[name] = { rank = rank, max = maxRank }
      end
    end
  end
end

-- Expand all collapsed categories so every recipe is visible to the API.
local function expandAll(expandFn, numFn, infoFn)
  if not expandFn then return end
  for _ = 1, 3 do
    local changed = false
    for i = numFn(), 1, -1 do
      local _, kind, _, isExpanded = infoFn(i)
      if kind == "header" and not isExpanded then
        expandFn(i)
        changed = true
      end
    end
    if not changed then break end
  end
end

local function saveTrade(tradeName, id, rank, maxRank, recipes)
  local c = charRecord()
  c.trades[tradeName] = { id = id, rank = rank, max = maxRank, recipes = recipes, updated = time() }
  print(("|cff33ff99WowAuctionHelper|r: saved %d known %s recipes (skill %d/%d)."):format(#recipes, tradeName, rank or 0, maxRank or 0))
end

-- Retail-style profession window (WoW Forever).
local function scanModernTradeSkill()
  local T = C_TradeSkillUI
  if not (T and T.GetAllRecipeIDs and T.GetRecipeInfo) then return false end
  if T.IsTradeSkillReady and not T.IsTradeSkillReady() then return true end
  if T.IsTradeSkillLinked and T.IsTradeSkillLinked() then return true end -- someone else's profession
  if T.IsTradeSkillGuild and T.IsTradeSkillGuild() then return true end
  if T.IsNPCCrafting and T.IsNPCCrafting() then return true end
  local info = (T.GetChildProfessionInfo and T.GetChildProfessionInfo()) or {}
  local base = (T.GetBaseProfessionInfo and T.GetBaseProfessionInfo()) or {}
  local name = base.professionName or info.professionName
  if not name or name == "" then return true end
  local rank = info.skillLevel or base.skillLevel
  local maxRank = info.maxSkillLevel or base.maxSkillLevel
  local id = base.professionID or info.parentProfessionID or info.professionID
  local recipes = {}
  for _, recipeID in ipairs(T.GetAllRecipeIDs() or {}) do
    local r = T.GetRecipeInfo(recipeID)
    if r and r.learned then
      local itemId
      if T.GetRecipeSchematic then
        local ok, sch = pcall(T.GetRecipeSchematic, recipeID, false)
        if ok and sch then itemId = sch.outputItemID end
      end
      table.insert(recipes, { s = recipeID, i = itemId, n = r.name })
    end
  end
  saveTrade(name, id, rank, maxRank, recipes)
  return true
end

-- Classic-style profession window (fallback for Classic Era clients).
local function scanTradeSkill()
  if scanModernTradeSkill() then return end
  if not GetTradeSkillLine then return end
  local tradeName, rank, maxRank = GetTradeSkillLine()
  if not tradeName or tradeName == "UNKNOWN" then return end
  expandAll(ExpandTradeSkillSubClass, GetNumTradeSkills, GetTradeSkillInfo)
  local recipes = {}
  for i = 1, GetNumTradeSkills() do
    local name, kind = GetTradeSkillInfo(i)
    if name and kind ~= "header" and kind ~= "subheader" then
      local spellId = GetTradeSkillRecipeLink and linkSpellId(GetTradeSkillRecipeLink(i)) or nil
      local itemId = GetTradeSkillItemLink and linkItemId(GetTradeSkillItemLink(i)) or nil
      table.insert(recipes, { s = spellId, i = itemId, n = name })
    end
  end
  saveTrade(tradeName, nil, rank, maxRank, recipes)
end

-- Enchanting (and Beast Training) use the older "Craft" API in Classic Era.
local function scanCraft()
  if not GetCraftDisplaySkillLine and not GetCraftSkillLine then return end
  local tradeName, rank, maxRank
  if GetCraftDisplaySkillLine then
    tradeName, rank, maxRank = GetCraftDisplaySkillLine()
  end
  if not tradeName and GetCraftSkillLine then
    tradeName, rank, maxRank = GetCraftSkillLine(1)
  end
  if not tradeName then return end -- e.g. Beast Training has no skill line
  expandAll(ExpandCraftSkillLine, GetNumCrafts, GetCraftInfo)
  local recipes = {}
  for i = 1, GetNumCrafts() do
    local name, _, kind = GetCraftInfo(i)
    if name and kind ~= "header" then
      local link = (GetCraftRecipeLink and GetCraftRecipeLink(i)) or (GetCraftItemLink and GetCraftItemLink(i))
      table.insert(recipes, { s = linkSpellId(link), i = linkItemId(link), n = name })
    end
  end
  saveTrade(tradeName, nil, rank, maxRank, recipes)
end

---------------------------------------------------------------------------
-- Export (JSON) -------------------------------------------------------------
local function jsonEscape(s)
  return (tostring(s):gsub('[%c"\\]', function(ch)
    if ch == '"' then return '\\"' end
    if ch == "\\" then return "\\\\" end
    return string.format("\\u%04x", ch:byte())
  end))
end

local function toJson(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" or t == "number" then return tostring(v) end
  if t == "string" then return '"' .. jsonEscape(v) .. '"' end
  if t == "table" then
    local n = #v
    local isArray = n > 0 or next(v) == nil
    if isArray then
      for k in pairs(v) do
        if type(k) ~= "number" then isArray = false break end
      end
    end
    local parts = {}
    if isArray then
      for i = 1, n do parts[#parts + 1] = toJson(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, val in pairs(v) do
      parts[#parts + 1] = '"' .. jsonEscape(k) .. '":' .. toJson(val)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local frame
local function showExport()
  scanSkills()
  local payload = "WAH1:" .. toJson({ version = 1, chars = WowAuctionHelperDB.chars })
  if not frame then
    frame = CreateFrame("Frame", "WowAuctionHelperExport", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
    frame:SetSize(520, 300)
    frame:SetPoint("CENTER")
    frame:SetFrameStrata("DIALOG")
    if frame.SetBackdrop then
      frame:SetBackdrop({
        bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
        edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
        tile = true, tileSize = 32, edgeSize = 32,
        insets = { left = 8, right = 8, top = 8, bottom = 8 },
      })
    end
    frame:EnableMouse(true)
    frame:SetMovable(true)
    frame:RegisterForDrag("LeftButton")
    frame:SetScript("OnDragStart", frame.StartMoving)
    frame:SetScript("OnDragStop", frame.StopMovingOrSizing)

    local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    title:SetPoint("TOP", 0, -14)
    title:SetText("WowAuctionHelper export - press Ctrl+C, then paste into the web app")

    local scroll = CreateFrame("ScrollFrame", "WowAuctionHelperExportScroll", frame, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 16, -36)
    scroll:SetPoint("BOTTOMRIGHT", -34, 44)

    local edit = CreateFrame("EditBox", nil, scroll)
    edit:SetMultiLine(true)
    edit:SetMaxLetters(0)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(460)
    edit:SetAutoFocus(true)
    edit:SetScript("OnEscapePressed", function() frame:Hide() end)
    scroll:SetScrollChild(edit)
    frame.edit = edit

    local close = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
    close:SetSize(100, 22)
    close:SetPoint("BOTTOM", 0, 14)
    close:SetText(CLOSE or "Close")
    close:SetScript("OnClick", function() frame:Hide() end)
  end
  frame.edit:SetText(payload)
  frame.edit:HighlightText()
  frame.edit:SetFocus()
  frame:Show()
end

---------------------------------------------------------------------------
local ev = CreateFrame("Frame")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("SKILL_LINES_CHANGED")
ev:RegisterEvent("TRADE_SKILL_SHOW")
ev:RegisterEvent("TRADE_SKILL_UPDATE")
ev:RegisterEvent("TRADE_SKILL_LIST_UPDATE")
ev:RegisterEvent("TRADE_SKILL_DATA_SOURCE_CHANGED")
ev:RegisterEvent("CRAFT_SHOW")
ev:RegisterEvent("CRAFT_UPDATE")

local pending = {}
local function later(key, fn)
  -- coalesce bursts of *_UPDATE events
  if pending[key] then return end
  pending[key] = true
  C_Timer.After(1.0, function()
    pending[key] = nil
    pcall(fn)
  end)
end

ev:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGIN" or event == "SKILL_LINES_CHANGED" then
    later("skills", scanSkills)
  elseif event == "TRADE_SKILL_SHOW" or event == "TRADE_SKILL_UPDATE"
      or event == "TRADE_SKILL_LIST_UPDATE" or event == "TRADE_SKILL_DATA_SOURCE_CHANGED" then
    later("trade", scanTradeSkill)
  elseif event == "CRAFT_SHOW" or event == "CRAFT_UPDATE" then
    later("craft", scanCraft)
  end
end)

SLASH_WOWAUCTIONHELPER1 = "/wah"
SlashCmdList.WOWAUCTIONHELPER = function(msg)
  msg = (msg or ""):lower()
  if msg == "reset" then
    WowAuctionHelperDB = { version = 1, chars = {} }
    print("|cff33ff99WowAuctionHelper|r: data cleared.")
  else
    showExport()
  end
end
