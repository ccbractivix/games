(function (root) {
  'use strict';

  if (!root.ResortRooms) {
    throw new Error('Room picker requires rooms.js to be loaded first.');
  }

  const { B1_WHOLE, B1_AB, B2, B3 } = root.ResortRooms.VILLA_DATA;
  const splitRooms = new Set(B1_AB);
  let nextId = 0;

  function mount(container, options = {}) {
    if (!(container instanceof Element)) throw new TypeError('Room picker requires a container element.');
    if (container.dataset.roomPickerMounted) throw new Error('Room picker is already mounted in this container.');
    container.dataset.roomPickerMounted = 'true';
    container.classList.add('resort-room-picker');
    const id = `resort-room-picker-${++nextId}`;
    container.innerHTML = `
      <div class="room-picker-field">
        <span class="room-picker-label" id="${id}-building-label">Building</span>
        <div class="room-picker-row" role="group" aria-labelledby="${id}-building-label" data-role="building">
          <button type="button" data-building="1" aria-pressed="false">Building 1</button>
          <button type="button" data-building="2" aria-pressed="false">Building 2</button>
          <button type="button" data-building="3" aria-pressed="false">Building 3</button>
        </div>
        <div class="room-picker-error" data-error="building" role="alert">Please select a building.</div>
      </div>
      <div class="room-picker-field" data-field="room" hidden>
        <label class="room-picker-label" for="${id}-room">Room Number</label>
        <select id="${id}-room" data-role="room"><option value="">— Select room —</option></select>
        <div class="room-picker-error" data-error="room" role="alert">Please select a room number.</div>
      </div>
      <div class="room-picker-field" data-field="unit" hidden>
        <span class="room-picker-label" id="${id}-unit-label">Unit</span>
        <div class="room-picker-row" role="group" aria-labelledby="${id}-unit-label" data-role="unit">
          <button type="button" data-unit="A" aria-pressed="false">A</button>
          <button type="button" data-unit="B" aria-pressed="false">B</button>
          <button type="button" data-unit="A+B" aria-pressed="false">A+B</button>
        </div>
        <div class="room-picker-error" data-error="unit" role="alert">Please select a unit (A, B, or A+B).</div>
      </div>
      <input type="hidden" data-role="value">
    `;

    const buildingRow = container.querySelector('[data-role="building"]');
    const roomField = container.querySelector('[data-field="room"]');
    const roomSelect = container.querySelector('[data-role="room"]');
    const unitField = container.querySelector('[data-field="unit"]');
    const unitRow = container.querySelector('[data-role="unit"]');
    const input = container.querySelector('[data-role="value"]');
    input.name = options.name || 'villa';
    let building = null;
    let room = null;
    let unit = null;

    function setActive(row, selected) {
      row.querySelectorAll('button').forEach(button => {
        const active = button === selected;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }

    function clearErrors() {
      container.querySelectorAll('.room-picker-error').forEach(error => error.classList.remove('show'));
    }

    function value() {
      if (!room) return '';
      if (building === 1 && splitRooms.has(room)) return unit ? `${room} ${unit}` : '';
      return String(room);
    }

    function notify() {
      input.value = value();
      container.dispatchEvent(new CustomEvent('room-picker-change', {
        bubbles: true,
        detail: { value: input.value, building, room, unit },
      }));
    }

    buildingRow.addEventListener('click', event => {
      const button = event.target.closest('button[data-building]');
      if (!button || !buildingRow.contains(button)) return;
      building = Number(button.dataset.building);
      room = null;
      unit = null;
      setActive(buildingRow, button);
      setActive(unitRow, null);
      clearErrors();
      roomSelect.replaceChildren(new Option('— Select room —', ''));
      const rooms = building === 1 ? [...B1_WHOLE, ...B1_AB].sort((a, b) => a - b) : building === 2 ? B2 : B3;
      rooms.forEach(number => roomSelect.add(new Option(String(number), String(number))));
      roomField.hidden = false;
      unitField.hidden = true;
      notify();
    });

    roomSelect.addEventListener('change', () => {
      room = roomSelect.value ? Number(roomSelect.value) : null;
      unit = null;
      setActive(unitRow, null);
      clearErrors();
      unitField.hidden = !(building === 1 && room && splitRooms.has(room));
      notify();
    });

    unitRow.addEventListener('click', event => {
      const button = event.target.closest('button[data-unit]');
      if (!button || !unitRow.contains(button)) return;
      unit = button.dataset.unit;
      setActive(unitRow, button);
      clearErrors();
      notify();
    });

    function validate() {
      clearErrors();
      const missing = !building ? 'building' : !room ? 'room' :
        building === 1 && splitRooms.has(room) && !unit ? 'unit' : null;
      if (missing) container.querySelector(`[data-error="${missing}"]`).classList.add('show');
      return !missing;
    }

    function reset() {
      building = null;
      room = null;
      unit = null;
      roomSelect.replaceChildren(new Option('— Select room —', ''));
      roomField.hidden = true;
      unitField.hidden = true;
      setActive(buildingRow, null);
      setActive(unitRow, null);
      clearErrors();
      notify();
    }

    return { getValue: value, validate, reset };
  }

  root.ResortRoomPicker = { mount };
})(window);
