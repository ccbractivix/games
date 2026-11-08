# Portable resort room picker

This is a copyable, plain HTML/CSS/JavaScript version of the guest checkout
room picker. It uses the same room roster as checkout: choose Building 1, 2,
or 3, then a room, and for applicable Building 1 rooms choose A, B, or A+B.
It needs no checkout backend, database, build tool, or JavaScript framework.
It does not submit anything by itself.

## Copy to another project

Copy the `room-picker` directory **and** `shared/rooms.js` into the other
project, keeping this layout:

```text
shared/
  rooms.js
  room-picker/
    room-picker.css
    room-picker.js
    example.html
    README.md
```

For an AI coding assistant working in the other repository, you can use:

> Add the portable resort room picker from `ccbractivix/RGP`: copy
> `shared/rooms.js` and `shared/room-picker/` into this project, then integrate
> it into the appropriate form following `shared/room-picker/README.md`.
> Preserve its current building, room, and A/B/A+B choices and validate the
> selected villa on the server before accepting it.

Open `shared/room-picker/example.html` in a browser to try it. To add it to
your own page, adjust these paths to match the page's location:

```html
<link rel="stylesheet" href="shared/room-picker/room-picker.css">
<!-- Optional: the same Inter font as checkout; otherwise a sans-serif fallback is used. -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">

<form id="my-form">
  <div id="room-picker"></div>
  <button type="submit">Continue</button>
</form>

<script src="shared/rooms.js"></script>
<script src="shared/room-picker/room-picker.js"></script>
<script>
  const picker = ResortRoomPicker.mount(document.getElementById('room-picker'));
  document.getElementById('my-form').addEventListener('submit', event => {
    if (!picker.validate()) {
      event.preventDefault();
      return;
    }
    // picker.getValue() is the selected villa, e.g. "1104" or "1105 A+B".
    // Continue with the host application's normal form submission or API call.
  });
</script>
```

`rooms.js` must load before `room-picker.js`. The picker inserts a hidden
form input named `villa`, so a normal form submission or `new FormData(form)`
includes the selected value. Set a different field name with
`ResortRoomPicker.mount(element, { name: 'room' })`.

The hidden input does not provide browser-native required validation: call
`picker.validate()` before submitting. It displays the relevant error and
returns `true` only for a complete selection. `picker.getValue()` returns an
empty string until the selection is complete. Call `picker.reset()` to clear
the picker; if your form has a reset button, call it in the form's `reset`
event handler as well.

To react to changes, listen for `room-picker-change` on the container. Its
`event.detail` contains `value`, `building`, `room`, and `unit`; incomplete
selections have an empty `value`. Building and room are numbers or `null`,
and unit is `A`, `B`, `A+B`, or `null`. The event also fires on reset.
Multiple pickers can be mounted in separate containers.

The stylesheet scopes its rules to `.resort-room-picker`; its
`--room-picker-*` CSS variables can be overridden on the container for a
different theme. The example uses checkout's colors and font.

## Room list and server validation

`rooms.js` is the source of the roster, including which Building 1 rooms need
a unit. Copy it together with the picker; changing this repository later will
not automatically update a copy in another repository. To update the other
project, copy the updated file again. If its server validates submitted
values, keep its allowed list in sync too: in Node.js, `require('./shared/rooms.js').VALID_VILLAS`
is a `Set` of the valid villa strings. Browser-side validation alone is not a
substitute for server-side validation.
